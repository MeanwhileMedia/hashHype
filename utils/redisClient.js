import redis from 'redis';
import yargs from 'yargs';
import redisClientConfig from './redisClient-config.js';
import commentModel from './objectModels/comment.js';
import wordModel from './objectModels/word.js';
import symbolModel from './objectModels/symbol.js';

const argv = yargs(process.argv.slice(2)).argv;
argv.host_redis_dbs = JSON.parse(argv.host_redis_dbs);

const objectModels = {
    'comment': commentModel,
    'word': wordModel,
    'symbol': symbolModel
}

// This extends wraps node_redis functionality. It hanldles multiple database configs, offers throttled functionality +more.
class RedisClient {
    constructor(opts) {
        const self = this;
        this.clients = null;
        this.redisDbConfigs = this.getRedisDbConfigs();

        self.restoredKeys = []; // For logging how many redis read/write commands resulted in data being recovered from 'long' db
        self.restoredKeysLongRecord = []; // This is a record kept for multiple intervals so we can determine restoredKeysLooping. See restoredKeysLooping (restoredKeysLoopingIntervalMaxCount)
        self.restoredKeysLooping = []; // these are keys that are found to be repeatedly restored within the last 2 intervals (perhaps they are being restored from long, but for some reason not persisting to short?)
        self.restoredKeyCountIntervalLength = 5000; // ms, how long should we count comments before we log the sum and restart. Set it to same as reddit fetchLoopIntervalTime for easy volume comparison.
        self.restoredKeyCountInterval = null;
        self.initRestoredKeyCountInterval();

        self.activePreservingSortedSets = {}; // {"word:GME:foundAt": setLength, etc..} a map of keys pointing to sorted sets which were all found to be long enough to be written to a preserve DB. (redisClientConfig.preserveNamespaces matched a key, and the set at that key had length >= preserveNamespaces.count)
        self.activePreservingSortedSetsPubSubChannel = 'change:activePreservingSortedSets'; // our manual pubsub channel so processes can keep activePreservingSortedSets in sync with one another
        self.activePreservingSortedSetsMaxLength = 10000;
        self.activePreservingSortedSetsSyncInterval = null;
        self.activePreservingSortedSetsSyncIntervalLength = 5000;

        let didFirstOnConnect = 0;
        this.initAllClients(() => {
            if (didFirstOnConnect) {
                console.warn(`RedisClient has unexpectedly called it's opts.onConnect callback ${didFirstOnConnect} times! Please inspect.`)
            }
            ++didFirstOnConnect;
            if (opts.onConnect) opts.onConnect();

            self.initActivePreservingSortedSetsSyncInterval();
        });
    }

    getRedisDbConfigs() {
        // Extract and normalize just certain properties from our redisClient-config file (the properties needed to connect a new db client).
        const selectedConfigObjs = [];
        argv.host_redis_dbs.forEach((thisDbName) => {
            selectedConfigObjs.push(redisClientConfig.servers[thisDbName]());
        });

        const redisDbConfigs = {};
        selectedConfigObjs.forEach((thisRedisConfig) => {
            redisDbConfigs[thisRedisConfig.dbName] = {
                dbName: thisRedisConfig.dbName,
                redisHost: thisRedisConfig.hostInfo.address,
                redisPort: thisRedisConfig.serverArgs.port,
                redisPassword: thisRedisConfig.serverArgs.requirepass,
                storeNamespaces: thisRedisConfig.storeNamespaces,
                preserveNamespaces: thisRedisConfig.preserveNamespaces
            };
        });
        return redisDbConfigs;
    }

    initAllClients(cback) {
        // assigns to this.clients object 2 clients for every db configured in redisClient-config.js -
        // one client for db actions, and another for pubsub actions. I.e. for a machine configured with
        // a "long" and "short" db, there would be 4 total clients connected when a new RedisClient is instantiated.
        const self = this;
        self.clients = {};
        const clientConnectPromises = [];
        for (const [thisDbName, thisDbConfig] of Object.entries(self.redisDbConfigs)) {
            const clientOpts = {
                host: thisDbConfig.redisHost,
                port: thisDbConfig.redisPort,
                password: thisDbConfig.redisPassword
            };
            clientConnectPromises.push(new Promise( (resolve, reject) => {
                self.initClientConnection(clientOpts, 'db', (node_redis_client) => {
                    if (node_redis_client) {
                        self.clients[thisDbName] = self.clients[thisDbName] || {};
                        self.clients[thisDbName].db = node_redis_client;
                        resolve(self.clients[thisDbName].db);
                    } else {
                        reject(null);
                    }
                });
            }));
            clientConnectPromises.push(new Promise( (resolve, reject) => {
                self.initClientConnection(clientOpts, 'pub', (node_redis_client) => {
                    if (node_redis_client) {
                        self.clients[thisDbName] = self.clients[thisDbName] || {};
                        self.clients[thisDbName].pub = node_redis_client;
                        resolve(self.clients[thisDbName].pub);
                    } else {
                        reject(null);
                    }
                });
            }));
            clientConnectPromises.push(new Promise( (resolve, reject) => {
                self.initClientConnection(clientOpts, 'sub', (node_redis_client) => {
                    if (node_redis_client) {
                        self.clients[thisDbName] = self.clients[thisDbName] || {};
                        self.clients[thisDbName].sub = node_redis_client;
                        resolve(self.clients[thisDbName].sub);
                    } else {
                        reject(null);
                    }
                });
            }));
        };
        Promise.all(clientConnectPromises).then(() => {
            if (cback) cback();
        });
    }

    initRemoteClient(dbName, cback) {
        // A process can connect to a DB defined within redisClient-config.js that isn't a part of this machine's argv.host_redis_dbs config. This type of client is "remote"
        // because this process is connecting to a DB hosted on another machine. The returned redis client is set to self.clients, and commands can be called just like they would
        // for our locally hosted DBs BUT with one exception: when running a command against the remote DB, the DB name MUST be specified as an arg to the command function:
        // self.redisClient.get('key', cback, 'remoteDbName'); // If remoteDbName is not provided, redisClient will attempt to get the key in one of the local host_redis_dbs, or return null for not found.
        // Important notes:
        // - This remote db connection will play no part in this machine's local dynamic db logic (determineTargetDb).
        // - remote connections do not support any publish commands - just db and sub.
        // - as a rule of thumb, remote connections should be used primarily for reads and subscriptions.
        const self = this;
        let remoteDbConfig = redisClientConfig.servers[dbName];
        if (remoteDbConfig) remoteDbConfig = remoteDbConfig();
        if (!remoteDbConfig || !remoteDbConfig.hostInfo.remoteAddress) {
            console.error(`Can't connect to remote redis db "${dbName}" because it's config is missing.`);
            if (cback) cback(false);
            return;
        }
        const clientOpts = {
            host: remoteDbConfig.hostInfo.remoteAddress,
            port: remoteDbConfig.serverArgs.port,
            password: remoteDbConfig.serverArgs.requirepass
        };
        const clientConnectPromises = [];
        clientConnectPromises.push(new Promise( (resolve, reject) => {
            self.initClientConnection(clientOpts, 'db', (node_redis_client) => {
                if (node_redis_client) {
                    self.clients[dbName] = self.clients[dbName] || {};
                    self.clients[dbName].db = node_redis_client;
                    resolve(self.clients[dbName].db);
                } else {
                    reject(null);
                }
            });
        }));
        clientConnectPromises.push(new Promise( (resolve, reject) => {
            self.initClientConnection(clientOpts, 'sub', (node_redis_client) => {
                if (node_redis_client) {
                    self.clients[dbName] = self.clients[dbName] || {};
                    self.clients[dbName].sub = node_redis_client;
                    resolve(self.clients[dbName].sub);
                } else {
                    reject(null);
                }
            });
        }));
        Promise.all(clientConnectPromises).then(() => {
            if (cback) cback();
        });
    }

    initClientConnection(clientOpts, clientType, onInitialConnect) {
        const node_redis_client = redis.createClient(clientOpts);
        node_redis_client.on('connect', function() {
            console.log(`New node_redis ${clientType} client connected: ${clientOpts.host}:${clientOpts.port}`);
            if (onInitialConnect) {  // This connect event fires during reconnects too, but the 'onInitialConnect' cback passed to this function only gets called once
                onInitialConnect(node_redis_client);
                onInitialConnect = null;
            }
        });
        node_redis_client.on('error', function(err) {
            console.warn('Error connectiong node_redis client:', err);
        });
        node_redis_client.on('reconnecting', function(stats) {
            console.warn(`Reconnection attempt #${stats.attempt} for node_redis ${clientType} client...`);
        });
    }

    initRestoredKeyCountInterval() {
        const self = this;
        if (self.restoredKeyCountInterval) return;

        const restoredKeysLongRecordIntervalMaxCount = 6; // how long should we hold self.restoredKeysLongRecord in memory while trying to determine when keys are in a recovery loop.
        let restoredKeysLongRecordIntervalCount = 0;
        self.restoredKeyCountInterval = setInterval(() => {
            if (self.restoredKeys.length) {
                console.warn(`Recovered ${self.restoredKeys.length} redis objects from preserved data in the last ${self.restoredKeyCountIntervalLength/1000} seconds.`);
                // if (self.restoredKeys.length < 100) console.warn(self.restoredKeys);
            }
            if (self.restoredKeysLooping.length > 100) console.warn(`WARNING: ${self.restoredKeysLooping.length} redis objects appear to be stuck in a recovery loop. Please inspect:`, self.restoredKeysLooping);
            if (restoredKeysLongRecordIntervalCount >= restoredKeysLongRecordIntervalMaxCount) {
                self.restoredKeysLongRecord = self.restoredKeysLongRecord.concat(self.restoredKeys);
                ++restoredKeysLongRecordIntervalCount;
            } else {
                self.restoredKeysLongRecord =  [];
                restoredKeysLongRecordIntervalCount = 0;
                self.restoredKeysLooping = [];
            }
            self.restoredKeys = [];
        }, self.restoredKeyCountIntervalLength);
    }

    initActivePreservingSortedSetsSyncInterval() {
        const self = this;
        if (self.activePreservingSortedSetsSyncInterval) return;
        self.activePreservingSortedSetsSyncInterval = setInterval(() => {
            const activePreservingSortedSetsLength = Object.keys(self.activePreservingSortedSets).length;
            console.log(`Currently preserving ${activePreservingSortedSetsLength} sorted sets which matched redis preserveNamespaces configs.`);
            if (activePreservingSortedSetsLength >= self.activePreservingSortedSetsMaxLength) {
                console.warn(`activePreservingSortedSets is too long! Potential memory leak. Please inspect...`);
            }

            // Alert all processes (including self) of changes we made to our local activePreservingSortedSets (because all processes must keep it in sync)
            const changes = {
                added: self.addedActivePreservingSortedSets || [],
                removed: self.removedActivePreservingSortedSets || []
            };
            self.publish(self.activePreservingSortedSetsPubSubChannel, changes);
            self.addedActivePreservingSortedSets = [];
            self.removedActivePreservingSortedSets = [];
        }, self.activePreservingSortedSetsSyncIntervalLength);

        self.addPubSubListenerForActivePreservingSortedSets();
    }
    addPubSubListenerForActivePreservingSortedSets() {
        const self = this;
        self.on('message', (channel, message) => {
            if (channel !== self.activePreservingSortedSetsPubSubChannel) return;
            const changes = JSON.parse(message);
            changes.added.forEach((thisAdded) => {
                self.activePreservingSortedSets[thisAdded.setKey] = thisAdded.setLength;
            });
            changes.removed.forEach((thisRemoved) => {
                delete self.activePreservingSortedSets[thisRemoved.setKey];
            });
        });
        self.subscribe(self.activePreservingSortedSetsPubSubChannel);
    }
    addActivePreservingSortedSet(setKey, setLength) {
        const self = this;
        // Keep track of add/remove changes because we will send out a pubsub message to alert other processes (and self) of these changes inside activePreservingSortedSetsSyncInterval. All processes must keep this object in sync.
        self.addedActivePreservingSortedSets = self.addedActivePreservingSortedSets || [];
        self.addedActivePreservingSortedSets.push({setKey, setLength});
    }
    removeActivePreservingSortedSet(setKey, setLength) {
        const self = this;
        self.removedActivePreservingSortedSets = self.removedActivePreservingSortedSets || [];
        self.removedActivePreservingSortedSets.push({setKey, setLength});
    }


    ///////
    // This redisClient class extends all node_redis functions which are used by hashHype. This is so
    // we can inject DB selection logic before any redis command is executed. The below determineTargetDb
    // looks at what type of command it is, the key(space), and will in some cases consider other args or
    // even intercept the command cback to perform post-functionality (e.g. after zadd, if a set is found
    // to be above a certain length, then automatically save to the long-term database, etc).
    determineTargetDb(commandArgs) { // commandArgs is normalized via normalizeRedisCommandArgs. determineTargetDb returns dbName or null (to cancel original command execution)
        const self = this;

        // ONLY non-batched redisClient functions will follow redisConfig.storeNamespaces patterns.
        // Batch commands (mget, mset, batch) don't provide a (single) key. Because of this, we will default to
        // always save batch commands to the "short" database.
        if (!commandArgs.key) return argv.host_redis_dbs[0]; // this is a batched command. return immediately

        /////////////
        // First determine which db(s) this command is configured to execute against. A key may be found to match a "storeNamespaces" pattern for multiple databases.
        const storeToDbs = [];
        const preserveToDbs = [];
        for (const [thisDbName, thisDbConfig] of Object.entries(self.redisDbConfigs)) {
            // 1. find matching thisDbConfig.storeNamespaces for this key
            if (!Array.isArray(thisDbConfig.storeNamespaces) || thisDbConfig.storeNamespaces.length === 0) continue;
            thisDbConfig.storeNamespaces.some((storeConf) => {
                if ( new RegExp(storeConf.pattern).test(commandArgs.key) ) {
                    storeConf.dbName = thisDbConfig.dbName;
                    storeToDbs.push(storeConf);
                    return true; // break some loop. We take use the first matching pattern only
                }
            });
            // 2. find matching thisDbConfig.preserveNamespaces for this key
            if (!Array.isArray(thisDbConfig.preserveNamespaces) || thisDbConfig.preserveNamespaces.length === 0) continue;
            thisDbConfig.preserveNamespaces.some((preserveConf) => {
                if ( new RegExp(preserveConf.pattern).test(commandArgs.key) ) {
                    preserveConf.dbName = thisDbConfig.dbName;
                    preserveToDbs.push(preserveConf)
                    return true; // break some loop
                }
            });
        };

        if (storeToDbs.length === 0) {
            console.warn(`Could not determine a target db name for ${commandArgs.command} command. Command args:`, commandArgs);
            return null;
        }
        if (storeToDbs.length === 1 && preserveToDbs.length === 0) {
            // This only matched one target DB. No need for anything fancy or async, just return the db name to to command func so it can proceed.
            return storeToDbs[0].dbName;
        }

        /////////////
        // hijack this command call because we've determined we need to control the read/write logic for this command (to multiple DBs).
        // By immediately returning null (for dbName), the original command function call will be cancelled. We then execute different behavior for read vs. write commands.
        const origCback = commandArgs.cback;
        const commandExecs = [];
        storeToDbs.forEach((thisStoreConf) => {
            commandExecs.push((execCback) => {
                commandArgs.dbName = thisStoreConf.dbName;
                commandArgs.cback = (redisRes) => {
                    if (execCback) execCback(redisRes, commandArgs.dbName);
                    if (thisStoreConf.ttl) self.pexpire(commandArgs.key, thisStoreConf.ttl, null, thisStoreConf.dbName);
                };
                self[commandArgs.command].apply(self, commandArgs.reformCommandArgs());
            });
        });
        if (commandArgs.isReadOp) {
            // If this is a isReadOp command, then we will attempt to read from target db just one at a time and return the first non-null response. If one DB returns null, then move on to the next.
            const preserveToExecs = [];
            preserveToDbs.forEach((thisPreserveConf) => {
                preserveToExecs.push((execCback) => {
                    commandArgs.dbName = thisPreserveConf.dbName;
                    commandArgs.cback = (redisRes) => {
                        // if (redisRes) console.log(`Could not find redis key in primary DB. Recovered ${commandArgs.key} from preserved data in "${thisPreserveConf.dbName}" DB.`);
                        if (execCback) execCback(redisRes, commandArgs.dbName);
                        if (thisPreserveConf.ttl) self.pexpire(commandArgs.key, thisPreserveConf.ttl, null, thisPreserveConf.dbName);
                    };
                    self[commandArgs.command].apply(self, commandArgs.reformCommandArgs());
                });
            });
            let curCmdExecIndex = 0;
            const nextCmdExec = (thisCmdExec) => {
                thisCmdExec((redisRes, foundInDbName) => {
                    if (redisRes === null || redisRes === 0) {
                        ++curCmdExecIndex;
                        if (combinedCmdExecs[curCmdExecIndex]) {
                            nextCmdExec(combinedCmdExecs[curCmdExecIndex]);
                        } else {
                            // console.warn(`Key ${commandArgs.key} was not found in any of the target DBs:`, storeToDbs)
                            if (origCback) origCback(redisRes);
                        }
                        return;
                    }
                    // console.log(`Executed redis ${commandArgs.command} command for key ${commandArgs.key} and returned a response from DB "${storeToDbs[curCmdExecIndex].dbName}". All target DBs:`, storeToDbs);

                    // log if this data was recovered from a db that was not 1st in list. Also sync data back down for certain commands.
                    if (curCmdExecIndex > 0) {
                        if (self.restoredKeys.indexOf(commandArgs.key) !== -1 || self.restoredKeysLongRecord.indexOf(commandArgs.key) !== -1) self.restoredKeysLooping.push(commandArgs.key);
                        self.restoredKeys.push(commandArgs.key);
                        if (commandArgs.command === 'get') {
                            // console.warn(`A recovered redis string (get) will be synced (set) to all DBs after recovery: ${commandArgs.key}`);
                            self.set(commandArgs.key, redisRes);
                        }
                        if (commandArgs.command === 'zcard') {
                            console.warn(`A recovered redis sorted set will be synced (zadd) to all DBs after recovery from ${foundInDbName} db: ${commandArgs.key}`);
                            self.zrange(commandArgs.key, 0, Infinity, (resSet) => {
                                self.zadd(commandArgs.key, resSet.reverse()); // zadd expects the reverse arg sig to what zrange returns [points1, val1, points2, val2]
                                if (self.restoredKeys.indexOf(commandArgs.key) !== -1 || self.restoredKeysLongRecord.indexOf(commandArgs.key) !== -1) self.restoredKeysLooping.push(commandArgs.key);
                                self.restoredKeys.push(commandArgs.key);
                            }, foundInDbName, 'WITHSCORES');
                        }
                    }

                    // If this was a zcard read, then this is when we act on preserveToDbs write logic. This is because our preserveNamespaces.count prop for sets depends on knowing the set's length. However,
                    // zadd does not return the set length, it returns how many items were added. This is why we have to work our preserve logic during the zcard read command.
                    if (commandArgs.command === 'zcard' && preserveToDbs.length) {
                        const minCountToPreserveSet = preserveToDbs[0].count;
                        if (redisRes >= minCountToPreserveSet) {
                            // We hold an obj in live memory of all set keys which exceeded our min count setting. All zadd commands check this object to see if they should write to preserve DB too.
                            // console.warn(`Will now begin preserving (db ${preserveToDbs[0].dbName}) all new zadds to key ${commandArgs.key} which has a length of ${redisRes}`);
                            self.addActivePreservingSortedSet(commandArgs.key, redisRes);
                        }
                    }

                    // Some string gets return a "keyAlias" object which is a reference to an abject at another key. Fetch the full object now, and let the cback know we followed an alias redirect.
                    if (redisRes.class === 'keyAlias' && commandArgs.command === 'get') {
                        self.get(redisRes.parentKey, (parentRedisObject) => {
                            const actualAbsKey = redisRes.parentKey; // When following an alias, the cback receives a 2nd argument "actualAbsKey". This let's the cback code know that its get cmd followed an alias.
                            if (origCback) origCback(parentRedisObject, actualAbsKey);
                        });
                        return;
                    }

                    if (origCback) origCback(redisRes);
                });
            };
            const combinedCmdExecs = commandExecs.concat(preserveToExecs);
            nextCmdExec(combinedCmdExecs[curCmdExecIndex]);
        } else {
            // If this is not a isReadOp command, and we just need to write to multiple DBs, then run all promises concurrently and execute provided cback once they all resolve.
            let didCallOrigCback = false; // we are gonna call this asap (with the first response from our set of commandExecs)
            commandExecs.forEach((thisCmdExec) => {
                thisCmdExec((redisRes, foundInDbName) => {
                    // We simplify things by just returning the response to the command from the first DB it was executed on. The assumption
                    // is that when a command is configured to be sent to multiple dbs, those dbs should be in sync and return the same response.
                    // console.log(`Executed redis ${commandArgs.command} command for key ${commandArgs.key} to multiple DBs:`, storeToDbs);
                    if (!didCallOrigCback && origCback) origCback(redisRes);
                    didCallOrigCback = true;

                    // Now execute our preserveNamespaces logic - which will vary depending on what type of write command was just executed.
                    if (preserveToDbs.length === 0) return;
                    const preserveToNow = (countForThisData) => {
                        preserveToDbs.forEach((thisPreserveToConfig) => {
                            if (countForThisData < thisPreserveToConfig.count) {
                                if (commandArgs.command !== 'del') { // destructive commands should always run on all DBS (including preserved) or else they will fall out of sync and there could be a delete/recover loop
                                    return;
                                }
                            }
                            commandArgs.dbName = thisPreserveToConfig.dbName;
                            commandArgs.cback = () => {
                                // console.log(`Preserved ${commandArgs.key} ${commandArgs.command} write command to ${commandArgs.dbName} DB...`)
                                if (thisPreserveToConfig.ttl) self.pexpire(commandArgs.key, thisPreserveToConfig.ttl, null, thisPreserveToConfig.dbName);
                            };
                            self[commandArgs.command].apply(self, commandArgs.reformCommandArgs());
                        });
                    }
                    if (commandArgs.command === 'set' && commandArgs.saveData) {
                        // the extended set command (see below) automatically increments a "saveCount" integer every time the same object is saved. Compare that number to the configured preserveNamespaces.count param and re-save.
                        preserveToNow(commandArgs.saveData.saveCount || 0);
                        return;
                    }
                    if (commandArgs.command === 'del') {
                        preserveToNow(0);
                        return;
                    }
                    const preservedSortedSetLength = self.activePreservingSortedSets[commandArgs.key];
                    if (preservedSortedSetLength && (commandArgs.command === 'zadd' || commandArgs.command === 'zrem' || commandArgs.command === 'zremrangebyscore')) {
                        preserveToNow(preservedSortedSetLength);
                    }
                });
            });
        }
        return null; // By immediately returning null (for dbName) the original command function call will be cancelled. We will call it again after our intercept logic.
    }
    normalizeRedisCommandArgs(commandType, commandArgs) {
        // Attempt to create a universal object model for all redis commands issued by hashHype. This will make
        // above determineTargetDb far less verbose (but we can still duplicate the native redis (node_redis) function signatures)
        const cmdArgsObj = {
            command: '', // this must always be defined
            dbName: null, // this will be set by determineTargetDb
            isReadOp: false, // if this is a get, zrange, etc, where a return value is expected in cback, then isReadOp will be true.
            key: null, // will not be defined in the case of batch commands (batch/mget/mset/etc)
            saveData: null, // string (set), array (zadd), array (zrem). will only be defined for write operations.
            startIndex: null, // int. will only be defined for certain sorted set commands (zrange, ztrim)
            endIndex: null, // int. will only be defined for certain sorted set commands (zrange, ztrim)
            ttlMs: null, // int (milliseconds). used for expire commands
            batchCmds: null, // array. a catch-all for any commands which receive an array of multiple commands (batch/mget/mset/etc)
            cback: null, // func. not all calls to a redis command are issued a cback
            reformCommandArgs: (dbName) => {
                // Take the normalized args (which may have been altered by determineTargetDb), and reform them into an array in the
                // correct order so that the orignal command function can be called via .apply.
                return cmdArgsObj.origArgs; // defaults to return origArgs. Each command type should ovverride this default below.
            },
            origArgs: commandArgs // also save an untouched copy of the original function call arguments signature
        }
        cmdArgsObj.command = commandType;
        if (cmdArgsObj.command === 'get') {
            cmdArgsObj.isReadOp = true;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'set') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.saveData = commandArgs[1] || null;
            cmdArgsObj.cback = commandArgs[2] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.saveData, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'del') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'zadd') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.saveData = commandArgs[1] || null;
            cmdArgsObj.cback = commandArgs[2] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.saveData, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'zrange') {
            cmdArgsObj.isReadOp = true;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.startIndex = commandArgs[1];
            if (typeof cmdArgsObj.startIndex !== 'number') cmdArgsObj.startIndex = null;
            cmdArgsObj.endIndex = commandArgs[2];
            if (typeof cmdArgsObj.endIndex !== 'number') cmdArgsObj.endIndex = null;
            cmdArgsObj.cback = commandArgs[3] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.startIndex, cmdArgsObj.endIndex, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'zcard') {
            cmdArgsObj.isReadOp = true;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'zrem') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.saveData = commandArgs[1] || null;
            cmdArgsObj.cback = commandArgs[2] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.saveData, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'zremrangebyscore') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.startIndex = commandArgs[1];
            if (typeof cmdArgsObj.startIndex !== 'number') cmdArgsObj.startIndex = null;
            cmdArgsObj.endIndex = commandArgs[2];
            if (typeof cmdArgsObj.endIndex !== 'number') cmdArgsObj.endIndex = null;
            cmdArgsObj.cback = commandArgs[3] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.startIndex, cmdArgsObj.endIndex, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'pexpire') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.ttlMs = commandArgs[1];
            if (typeof cmdArgsObj.ttlMs !== 'number') cmdArgsObj.ttlMs = null;
            cmdArgsObj.cback = commandArgs[2] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.ttlMs, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'keys') {
            cmdArgsObj.isReadOp = true;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'mget') {
            cmdArgsObj.isReadOp = true;
            cmdArgsObj.batchCmds = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.batchCmds, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'mset') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.batchCmds = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.batchCmds, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'batch') {
            cmdArgsObj.isReadOp = true; // batch is an edge case where we may have a mix or read/write ops. Additional logic will be required when processing cback.
            cmdArgsObj.batchCmds = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.batchCmds, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
    }

    ///////
    // First are extended redis string functions
    get(key, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('get', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.get(normalizedArgs.key, (err, json) => {
            if (err) {
                console.warn(err);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            if (!json) {
                // console.warn(`Could not find redis key: ${normalizedArgs.key}`);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            let redisObject = null;
            try {
                redisObject = JSON.parse(json);
            } catch (error) {
                console.warn(`Failed to parse invalid JSON for redis key: ${normalizedArgs.key}`, error);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }

            if (normalizedArgs.cback) normalizedArgs.cback(redisObject);
        });
    }

    set(key, redisObj, cback, dbName) {
        const self = this;
        if (redisObj.deleted) {
            console.warn(`Can't save a redis object which was locally flagged as deleted (${key})`);
            if (cback) cback();
            return;
        }
        const normalizedArgs = self.normalizeRedisCommandArgs('set', arguments);
        if (normalizedArgs.saveData) {
            // Our extended set command automatically tracks TOTAL times this key was saved over all time (to assist preserveNamespaces logic)
            normalizedArgs.saveData.saveCount = normalizedArgs.saveData.saveCount || 0;
            ++normalizedArgs.saveData.saveCount;
            normalizedArgs.saveData.lastUpdated = Date.now();
        }
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.set(normalizedArgs.key, JSON.stringify(normalizedArgs.saveData), (err) => {
            if (err) console.warn(err);
            if (normalizedArgs.cback) normalizedArgs.cback();
        });
    }

    del(key, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('del', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.del(normalizedArgs.key, (err, res) => {
            if (err) console.warn(err);
            if (normalizedArgs.cback) normalizedArgs.cback(res);
        });
    }

    ////////
    // Up next, Sorted Set commands. This structure is used by index:wordToComments to maintain an ordered list of commentIds which
    // are scored using their createdAt tstamps. zrange can be used to extract onlt commentIds which fall in a certain timerange.
    // NOTE: Values are NEVER automatically JSON stringified/parsed in any sorted set commands. If JSON is being added to set, it should be handled before passing to extended redis commands.
    // https://github.com/NodeRedis/node-redis/blob/09f0fe822862baf0f2a5d2b37537babffaae66d8/test/commands/zadd.spec.js
    zadd(key, addObjects, cback, dbName) {
        // addObjects = [item1Points, item1StrValue, item2Points, item2StrValue, etc...]
        // Each itemStrValue passed to zadd MUST already be a string. redisClient does no type conversion for zadd.
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('zadd', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.zadd(normalizedArgs.key, normalizedArgs.saveData, (err, itemsAddedCount) => {
            if(err || typeof itemsAddedCount !== 'number') {
                console.warn(`Could not zadd ${normalizedArgs.saveData.length/2} objects to redis sorted set ${normalizedArgs.key}:`, normalizedArgs.saveData, err);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(itemsAddedCount);
        });
    }

    zrange(key, startIndex, endIndex, cback, dbName, withScores = '') {
        // Currently, hashHype zrange only supports (and defaults to) "BYSCORE" range requests. startIndex, endIndex args
        // are the min and max score for items to be returned. withScores (disabled by default) can be sent and the return response will
        // include values AND scores like: [item1StrValue, item1Points, item2StrValue, item2Points, etc...]
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('zrange', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;

        const cmdCback = (err, listItems) => {
            // Returned "listItems" is an array of all values which fell into the provided score range (startIndex, endIndex).
            if(err || !listItems) {
                console.warn(`Could not zrange redis sorted set ${normalizedArgs.key}:`, err);
                if (normalizedArgs.cback) normalizedArgs.cback([]);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(listItems);
        };
        if (withScores) {
            self.clients[dbName].db.zrange(normalizedArgs.key, normalizedArgs.startIndex, normalizedArgs.endIndex, 'BYSCORE', 'WITHSCORES', cmdCback);
        } else {
            self.clients[dbName].db.zrange(normalizedArgs.key, normalizedArgs.startIndex, normalizedArgs.endIndex, 'BYSCORE', cmdCback);
        }
    }

    zcard(key, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('zcard', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.zcard(normalizedArgs.key, (err, length) => {
            if(err || typeof length !== 'number') {
                console.warn(`Could not zcard redis list ${normalizedArgs.key}:`, err);
                if (normalizedArgs.cback) normalizedArgs.cback(0);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(length);
        });
    }

    zrem(key, members, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('zrem', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.zrem(normalizedArgs.key, normalizedArgs.saveData, (err, itemsRemovedCount) => {
            if(err || typeof itemsRemovedCount !== 'number') {
                console.warn(`Could not zrem ${normalizedArgs.saveData.length} objects to redis sorted set ${normalizedArgs.key}:`, normalizedArgs.saveData, err);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(itemsRemovedCount);
        });
    }

    zremrangebyscore(key, startIndex, endIndex, cback, dbName) {
        // startIndex, endIndex args are the min and max score for items to be removed.
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('zremrangebyscore', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.zremrangebyscore(normalizedArgs.key, normalizedArgs.startIndex, normalizedArgs.endIndex, (err, itemsRemovedCount) => {
            if(err || typeof itemsRemovedCount !== 'number') {
                console.warn(`Could not zremrangebyscore redis sorted set ${normalizedArgs.key}:`, err);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(itemsRemovedCount);
        });
    }

    /////////////
    // Next are extended batch read/write command functions. These ARE ONLY USED FOR redisClient.throttle functions!
    batch(cmdsArray, cback, dbName) {
        // cmdsArray is [['set', 'key:foo_bar', 'json'], ['lrange', 'key:foo_bar', 0, -1, cback], ['get', 'key:foo_bar', cback], etc...]
        // NOTE: ALL items in the cmdsArray should already be stringified and ready to execute. If the cmd reuires a cback, can be passed
        // for each individual command (as last item in a single cmd array). The "cback" arg for this function is called after all commands have completed.
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('batch', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.batch(normalizedArgs.batchCmds).exec(function(err, res) {
            if(err || !res) {
                console.warn(`Could not batch ${normalizedArgs.batchCmds.length} redis commands.`, err);
                if (normalizedArgs.cback) normalizedArgs.cback([]);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(res);
        });
    }

    mget(mgetArgs, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('mget', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.mget(normalizedArgs.batchCmds, (err, resArray) => {
            if(err || !resArray || resArray.length === 0) {
                console.warn(`Could not mget ${normalizedArgs.batchCmds.length} keys from redis`, normalizedArgs.batchCmds, err);
                return;
            }
            const resObjects = [];
            resArray.forEach((json) => {
                if (!json) {
                    // console.warn(`Mget could not find redis key: ${key}`);
                    resObjects.push(null);
                    return;
                }
                let redisObject = null;
                try {
                    redisObject = JSON.parse(json);
                } catch (error) {
                    console.warn(`Mget failed to parse invalid redis JSON.`);
                    resObjects.push(null);
                    return;
                }
                resObjects.push(redisObject);
            });
            if (normalizedArgs.cback) normalizedArgs.cback(resObjects);
        });
    }

    mset(msetArgs, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('mset', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.mset(normalizedArgs.batchCmds, (err, res) => {
            if(err) {
                console.warn(`Could not mset ${normalizedArgs.batchCmds.length/2} keys to redis`, normalizedArgs.batchCmds, err);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(res);
        });
    }

    /////////
    // Other misc supported commands next.
    pexpire(key, ttlMs, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('pexpire', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.pexpire(normalizedArgs.key, normalizedArgs.ttlMs, (err, res) => { // res is 1 for success, 0 for key does no exist
            if (err) console.warn(err);
            if (normalizedArgs.cback) normalizedArgs.cback(res);
        });
    }

    keys(key, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('keys', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.keys(normalizedArgs.key, (err, res) => {
            if (err) {
                console.warn(err);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            if (!res) {
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(res);
        });
    }

    info(category = 'all', cback, dbName = 'all') {
        const self = this;
        const gotInfoForDbs = []; // Where the responses will be held for all dbs until ready for cback
        let getInfoForDbs = [dbName];
        const getInfoForDb = (thisDbClient, dbName, cback) => {
            thisDbClient.info(category, function (err, res) {
                if(err) {
                    console.warn(`Could not get info for DB "${dbName}"`, err, res);
                    return;
                }
                cback(thisDbClient.server_info); // node_redis transfered this data to it's own "client.server_info" object. Let's reuse that instead of parsing the res ourselves.
            });
        }
        if (getInfoForDbs[0] === 'all') {
            getInfoForDbs = Object.keys(self.redisDbConfigs);
        }
        let gotInfoResponseCount = 0;
        getInfoForDbs.forEach((thisDbName) => {
            getInfoForDb(self.clients[thisDbName].db, thisDbName, (serverInfoObj) => {
                serverInfoObj.dbName = thisDbName;
                gotInfoForDbs.push(serverInfoObj);
                ++gotInfoResponseCount;
                if (gotInfoResponseCount >= getInfoForDbs.length && cback) cback(gotInfoForDbs);
            });
        });
    }

    ////////
    // Below are extended pubsub functions. NOT YET normalized or routed through "determineTargetDb"
    on(msgChannel, cback, dbName) {
        const self = this;
        if (!dbName) dbName = argv.host_redis_dbs[0];
        self.clients[dbName].sub.on(msgChannel, cback);
    }

    subscribe(msgChannel, dbName) {
        const self = this;
        if (!dbName) dbName = argv.host_redis_dbs[0];
        self.clients[dbName].sub.subscribe(msgChannel);
    }

    unsubscribe(msgChannel, dbName) {
        const self = this;
        if (!dbName) dbName = argv.host_redis_dbs[0];
        self.clients[dbName].sub.unsubscribe(msgChannel);
    }

    psubscribe(msgChannel, dbName) {
        const self = this;
        if (!dbName) dbName = argv.host_redis_dbs[0];
        self.clients[dbName].sub.psubscribe(msgChannel);
    }

    publish(msgChannel, message, dbName) { // if message is typeof != string, then this function will automatically JSON stringify before publishing message.
        const self = this;
        if (!dbName) dbName = argv.host_redis_dbs[0];
        if (typeof message !== 'string') message = JSON.stringify(message);
        self.clients[dbName].pub.publish(msgChannel, message);
    }

}

export default RedisClient;
