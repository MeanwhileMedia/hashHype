import redis from 'redis';
import yargs from 'yargs';
const cliArgs = yargs(process.argv).argv;

const buffer = new Buffer(cliArgs.dbs, 'base64');
const redisDbConfigsJson = buffer.toString('ascii');
const redisDbConfigs = JSON.parse(redisDbConfigsJson);

// This extends wraps node_redis functionality. It hanldles multiple database configs, offers throttled functionality +more.
class RedisClient {
    constructor(opts) {
        const self = this;
        this.clients = null;
        this.initAllClients(() => {
            self.attachThrottleFuncs();
            self.throttle.initSetBatchInterval();
            self.throttle.initGetBatchInterval();
            self.throttle.initLrangeBatchInterval();
            self.throttle.initClearCachedGetObjectsInterval();
            if (opts.onConnect) opts.onConnect();
        });
    }

    initAllClients(cback) {
        // assigns to this.clients object 2 clients for every db configured in redisClient-config.js -
        // one client for db actions, and another for pubsub actions. I.e. for a machine configured with
        // a "long" and "short" db, there would be 4 total clients connected when a new RedisClient is instantiated.
        const self = this;
        self.clients = {};
        const clientConnectPromises = [];
        for (const [thisDbName, thisDbConfig] of Object.entries(redisDbConfigs)) {
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
                self.initClientConnection(clientOpts, 'pubsub', (node_redis_client) => {
                    if (node_redis_client) {
                        self.clients[thisDbName] = self.clients[thisDbName] || {};
                        self.clients[thisDbName].pubsub = node_redis_client;
                        resolve(self.clients[thisDbName].pubsub);
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

    initClientConnection(clientOpts, clientType, onConnect) {
        const node_redis_client = redis.createClient(clientOpts);
        node_redis_client.on('connect', function() {
            console.log(`New node_redis ${clientType} client connected: ${clientOpts.host}:${clientOpts.port}`);
            onConnect(node_redis_client);
        });
        node_redis_client.on("error", function(err) {
            console.warn('Error connectiong node_redis client:', err);
        });
    }

    ///////
    // This redisClient class extends all node_redis functions which are used by hashHype. This is so
    // we can inject DB selection logic before any redis command is executed. The below determineTargetDb
    // looks at what type of command it is, the key(space), and will in some cases consider other args or
    // even intercept the command cback to perform post-functionality (e.g. after rpush, if a list is found
    // to be above a certain length, then automatically save to the long-term database, etc).
    determineTargetDb(commandArgs) { // commandArgs is normalized via normalizeRedisCommandArgs. determineTargetDb returns dbName or null (to cancel original command execution)
        const self = this;

        // ONLY non-throttled redisClient functions will follow redisConfig.storeNamespaces patterns.
        // Batch commands (mget, mset, batch) don't provide a (single) key. Because of this, we will default to
        // always save batch commands to the "short" database. These redis commands should only be used by redisClient.throttled functions,
        // and as they are intented to be most performant, dynamic db logic, async callback masking, etc, would defeat the purpose.
        if (!commandArgs.key) return 'short'; // this is a throttled, batched command. return immediately

        /////////////
        // First determine which db(s) this command is configured to execute against. A key may be found to match a "storeNamespaces" pattern for multiple databases.
        let targetDbNames = [];
        for (const [thisDbName, thisDbConfig] of Object.entries(redisDbConfigs)) {
            if (!Array.isArray(thisDbConfig.storeNamespaces)) continue;
            const namespaceMatchPatterns = thisDbConfig.storeNamespaces.join('|');
            const namespaceMatchRegex = new RegExp(namespaceMatchPatterns, 'g');
            const saveToThisDb = namespaceMatchRegex.test(commandArgs.key);
            if (saveToThisDb && targetDbNames.indexOf(thisDbConfig.dbName) === -1) targetDbNames.push(thisDbConfig.dbName);
        };
        if (targetDbNames.length === 0) {
            console.warn(`Could not determine a target db name for ${commandArgs.command} command. Command args:`, commandArgs)
            return null;
        }
        if (targetDbNames.length === 1) {
            // This only matched one target DB. No need for anything fancy or async, just return the db name to to command func so it can proceed.
            return targetDbNames[0];
        }

        /////////////
        // hijack this command call because we've determined we need to control the read/write logic for this command (to multiple DBs).
        // By immediately returning null (for dbName), the original command function call will be cancelled. We then execute different behavior for read vs. write commands.
        const origCback = commandArgs.cback;
        const commandPromises = [];
        targetDbNames.forEach((thisTargetDbName) => {
            commandPromises.push(new Promise( (resolve, reject) => {
                commandArgs.dbName = thisTargetDbName;
                commandArgs.cback = resolve;
                self[commandArgs.command].apply(self, commandArgs.reformCommandArgs());
            }));
        });
        if (commandArgs.isReadOp) {
            // If this is a isReadOp command, then we will attempt to read from target db just one at a time and return the first non-null response. If one DB returns null, then move on to the next.
            let curPromise = 0;
            const execPromise = (promise, cback) => {
                promise.then((redisRes) => {
                    if (redisRes === null) {
                        ++curPromise;
                        if (commandPromises[curPromise]) {
                            execPromise(commandPromises[curPromise]);
                        } else {
                            // console.warn(`Key ${commandArgs.key} was not found in any of the target DBs:`, targetDbNames)
                            if (origCback) origCback(null);
                        }
                        return;
                    }
                    // console.log(`Executed redis ${commandArgs.command} command for key ${commandArgs.key} and returned a first response from DB "${targetDbNames[curPromise]}". All target DBs:`, targetDbNames);
                    if (origCback) origCback(redisRes);
                });
            };
            execPromise(commandPromises[curPromise]);
        } else {
            // If this is not a isReadOp command, and we just need to write to multiple DBs, then run all promises concurrently and execture provided cback once they all resolve.
            Promise.all(commandPromises).then((allResponses) => {
                // We simplify things by just returning the response to the command from the first DB it was executed on. The assumption
                // is that when a command is configured to be sent to multiple dbs, those dbs should be in sync and return the same response.
                // console.log(`Executed redis ${commandArgs.command} command for key ${commandArgs.key} to multiple DBs:`, targetDbNames);
                if (origCback) origCback(allResponses[0]);
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
            isReadOp: false, // if this is a get, lrange, etc, where a return value is expected in cback, then isReadOp will be true.
            key: null, // will not be defined in the case of batch commands (batch/mget/mset/etc)
            saveData: null, // string or int. will only be defined for write operations
            startIndex: null, // int. will only be defined for certain list commands (lrange, ltrim)
            endIndex: null, // int. will only be defined for certain list commands (lrange, ltrim)
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
        if (cmdArgsObj.command === 'del') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'rpush') {
            cmdArgsObj.isReadOp = true; // because this command returns the new list length (int)
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.saveData = commandArgs[1] || null;
            cmdArgsObj.cback = commandArgs[2] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.saveData, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'lrange') {
            cmdArgsObj.isReadOp = true;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.startIndex = commandArgs[1] || null;
            cmdArgsObj.endIndex = commandArgs[2] || null;
            cmdArgsObj.cback = commandArgs[3] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.startIndex, cmdArgsObj.endIndex, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'llen') {
            cmdArgsObj.isReadOp = true;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.cback = commandArgs[1] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.cback, cmdArgsObj.dbName];
            };
            return cmdArgsObj;
        }
        if (cmdArgsObj.command === 'ltrim') {
            cmdArgsObj.isReadOp = false;
            cmdArgsObj.key = commandArgs[0];
            cmdArgsObj.startIndex = commandArgs[1] || null;
            cmdArgsObj.endIndex = commandArgs[2] || null;
            cmdArgsObj.cback = commandArgs[3] || null;
            cmdArgsObj.reformCommandArgs = () => {
                return [cmdArgsObj.key, cmdArgsObj.startIndex, cmdArgsObj.endIndex, cmdArgsObj.cback, cmdArgsObj.dbName];
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
        const normalizedArgs = self.normalizeRedisCommandArgs('set', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.set(key, JSON.stringify(normalizedArgs.saveData), (err) => {
            if (err) console.warn(err);
            if (normalizedArgs.cback) normalizedArgs.cback();
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

    //////////
    // Extended list functions DO NOT auto stringify/parse redis data. (that feature is only for redis string commands)
    // These list functions will attempt to save/return data exactly as it's receives as an arg or redis response.
    rpush(key, pushObjects, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('rpush', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.rpush(normalizedArgs.key, normalizedArgs.saveData, (err, listLength) => {
            if(err || !listLength) {
                console.warn(`Could not rpush ${normalizedArgs.saveData.length} objects to redis list ${normalizedArgs.key}:`, normalizedArgs.saveData, err);
                if (normalizedArgs.cback) normalizedArgs.cback(null);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(listLength);
        });
    }

    lrange(key, startIndex, endIndex, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('lrange', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.lrange(normalizedArgs.key, normalizedArgs.startIndex, normalizedArgs.endIndex, (err, listItems) => {
            if(err || !listItems) {
                console.warn(`Could not lrange redis list ${normalizedArgs.key}:`, err);
                if (normalizedArgs.cback) normalizedArgs.cback([]);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(listItems);
        });
    }

    llen(key, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('llen', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.llen(normalizedArgs.key, (err, length) => {
            if(err || typeof length !== 'number') {
                console.warn(`Could not llen redis list ${normalizedArgs.key}:`, err);
                if (normalizedArgs.cback) normalizedArgs.cback(0);
                return;
            }
            if (normalizedArgs.cback) normalizedArgs.cback(length);
        });
    }

    ltrim(key, startIndex, endIndex, cback, dbName) {
        const self = this;
        const normalizedArgs = self.normalizeRedisCommandArgs('ltrim', arguments);
        if (!dbName) dbName = self.determineTargetDb(normalizedArgs);
        if (!dbName) return;
        self.clients[dbName].db.ltrim(normalizedArgs.key, normalizedArgs.startIndex, normalizedArgs.endIndex, (err, res) => {
            if (err) console.warn(err);
            if (normalizedArgs.cback) normalizedArgs.cback(res);
        });
    }

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

    ////////
    // Below are extended pubsub functions. NOT YET normalized or routed through "determineTargetDb"
    on(msgChannel, cback, dbName = 'short') {
        const self = this;
        self.clients[dbName].pubsub.on(msgChannel, cback);
    }

    subscribe(msgChannel, dbName = 'short') {
        const self = this;
        self.clients[dbName].pubsub.subscribe(msgChannel);
    }

    psubscribe(msgChannel, dbName = 'short') {
        const self = this;
        self.clients[dbName].pubsub.psubscribe(msgChannel);
    }

    ////////
    // Attach our stateful throttle object to this class.
    attachThrottleFuncs() {
        const self = this;
        // Adds client.throttled.set and client.throttled.get, and some list commands. Will batch these redis requests then
        // fire them as mset and mget in an interval (or when the queue reaches a max size).
        // ONLY non-throttled redisClient functions will follow redisConfig.storeNamespaces patterns. EVERYTHING run
        // through these functions is run against the "single" db.
        this.throttle = {
            setIntervalTime: 5000, // stagger these so our intervals don't all hit simultaneously
            maxSetBatchSize: 100, // total number of callbacks that would need to be registed to all set keys to trigger the redis request
            getIntervalTime: 4000,
            maxGetBatchSize: 100,
            lrangeIntervalTime: 3000,
            maxLrangeBatchSize: 500,

            ////////
            // SET (batched)
            pendingSetBatch: {}, // {key: object (not yet stringified)}
            pendingSetBatchCount: 0,
            set: (key, object, cback) => { //ONLY pass objects the throttled set, not stringified JSON
                if(!self.throttle.pendingSetBatch[key]) self.throttle.pendingSetBatchCount++;
                self.throttle.pendingSetBatch[key] = object;
                if (self.throttle.pendingSetBatchCount === self.throttle.maxSetBatchSize) self.throttle.setBatch();
                if (cback) cback(); // currently not waiting for mset cback - let code proceed as if set happened immediately
            },
            setBatchInterval: null,
            initSetBatchInterval: () => {
                if (self.throttle.setBatchInterval) return;
                self.throttle.setBatchInterval = setInterval(() => {
                    self.throttle.setBatch();
                }, self.throttle.setIntervalTime);
            },
            setBatch: () => {
                self.throttle.pendingSetBatchCount = 0;
                const msetArgs = [];
                for (const [key, value] of Object.entries(self.throttle.pendingSetBatch)) {
                    msetArgs.push(key, JSON.stringify(value));
                }
                if (msetArgs.length === 0) return;
                console.log(`Now running batched mset for ${msetArgs.length/2} keys...`);
                self.mset(msetArgs);
                self.throttle.pendingSetBatch = {};
            },

            ////////
            // GET (batched)
            pendingGetBatch: {}, // {key: [cback, cback, etc]}
            pendingGetBatchCount: 0,
            get: (key, cback) => { // ALWAYS returns a parsed JSON object (unlike standard redis get)
                if (self.throttle.pendingSetBatch[key]) {
                    // Looks like we are holding a local copy of this key (it's set was throttled)
                    // Return this local copy because we will assume it is more up-to-date than what's in redis.
                    if (cback) cback(self.throttle.pendingSetBatch[key]);
                    return;
                }
                if(!self.throttle.pendingGetBatch[key]) self.throttle.pendingGetBatchCount++;
                self.throttle.pendingGetBatch[key] = self.throttle.pendingGetBatch[key] || [];
                self.throttle.pendingGetBatch[key].push(cback);
                if (self.throttle.pendingGetBatchCount === self.throttle.maxGetBatchSize) self.throttle.getBatch();
            },
            getBatchInterval: null,
            initGetBatchInterval: () => {
                if (self.throttle.getBatchInterval) return;
                self.throttle.getBatchInterval = setInterval(() => {
                    self.throttle.getBatch();
                }, self.throttle.getIntervalTime);
            },
            getBatch: () => {
                self.throttle.pendingGetBatchCount = 0;
                const mgetArgs = Object.keys(self.throttle.pendingGetBatch);
                if (mgetArgs.length === 0) return;
                const mgetCbacks = self.throttle.pendingGetBatch; // Clear out self.throttle.pendingGetBatch asap so we don't get overlap with incoming calls to throttled get
                self.throttle.pendingGetBatch = {};

                console.log(`Now running batched mget for ${mgetArgs.length} keys...`);
                self.mget(mgetArgs, (resArray) => {
                    if(resArray.length === 0) return;
                    mgetArgs.forEach((key, thisKeyIndex) => {
                        const cbacksForThisKey = mgetCbacks[key];
                        if (!cbacksForThisKey || cbacksForThisKey.length === 0) return;
                        cbacksForThisKey.forEach((thisCback) => {
                            if (typeof thisCback !== 'function') return;
                            let gotObject = resArray[thisKeyIndex];
                            thisCback(gotObject);
                        });
                    });
                });
            },

            ////////
            // GET (cached)
            cachedGetObjectsMaxSize: 200, // only stores the most recently used cached objects
            cachedGetObjects: [], // held as an array for quick unshift and splice (to limit cache size)
            cachedGetObjectsIndex: {}, // also maintain an index for increased performance (don't have to loop through array for every getCached request) {'redis:key': int (index within cachedGetObjects array), etc..}
            cachedGetObjectsAccessLog: [], // every time a redis key is returned via getCached (whether from cache, or from redis), it's key is pushed to this array. cachedGetObjectsAccessLog is used to meet cachedGetObjectsMaxSize in an LRU fashion.
            clearCachedGetObjectsIntervalTime: 60000*10, // 10 mins - completely clear out cached get objects in intervals to ensure fresh data in local memory, and to clear out accessLog
            getCached: (redisKey, cback) => { // ALWAYS returns a JSON parsed object to cback
                self.throttle.cachedGetObjectsAccessLog.push(redisKey);
                // Can use this function to get an object but then hold it in local live memory. If getCached
                // is called again for same key, the live object is returned immediately. This function is useful
                // for data that is requested frequently, but does not change in redis frequently. (big performance
                // gain for speed and memory because we aren't holding a ton of node_redis queue items in memory).
                const cachedObjectIndex = self.throttle.cachedGetObjectsIndex[redisKey];
                if (typeof cachedObjectIndex === 'number' && self.throttle.cachedGetObjects[cachedObjectIndex]) {
                    const cachedObject = self.throttle.cachedGetObjects[cachedObjectIndex];
                    if (cback) cback(cachedObject);
                    // console.log(`Got a cached object from cachedGetObjects: ${redisKey} -> ${cachedObject.redisKey}`);
                    return;
                }
                // Did not exist in cached, fetch from redis then add to cached, then rebuild cachedGetObjectsIndex
                self.throttle.get(redisKey, (gotObj) => {
                    if (cback) cback(gotObj);
                    if (!gotObj) {
                        console.log(`getCached could not find key in redis: ${redisKey}`);
                        return;
                    }
                    gotObj.redisKey = gotObj.redisKey || redisKey; // save this directly on object to assist in reindexing below (cachedGetObjectsIndex)
                    const cachedGetObjectsLength = self.throttle.cachedGetObjects.push(gotObj);
                    self.throttle.cachedGetObjectsIndex[redisKey] = cachedGetObjectsLength - 1; // 0 based
                    // console.log(`Got an object from redis and will now hold in cachedGetObjects: ${redisKey}. Cache size: ${cachedGetObjectsLength}/${self.throttle.cachedGetObjectsMaxSize}`);
                    if (self.throttle.cachedGetObjects.length === self.throttle.cachedGetObjectsMaxSize) {
                        console.log(`cachedGetObjects array has exceeded size limit (${self.throttle.cachedGetObjects.length}/${self.throttle.cachedGetObjectsMaxSize}). Clearing LRU items...`);
                        self.throttle.trimCachedGetObjects();
                    }
                });
            },
            trimCachedGetObjects: () => {
                const accessLog = self.throttle.cachedGetObjectsAccessLog.reverse();
                self.throttle.cachedGetObjectsAccessLog = [];
                const cachedGetObjectsTargetLength = Math.round(self.throttle.cachedGetObjectsMaxSize * .8); // Free up 20% so we aren't running this cache trimming logic for every single call to getCached (after the cache has filled)
                const keepRedisKeys = [];
                accessLog.some((accessedRedisKey) => {
                    if (keepRedisKeys.indexOf(accessedRedisKey) === -1) {
                        keepRedisKeys.push(accessedRedisKey);
                        if (keepRedisKeys.length === cachedGetObjectsTargetLength) return true; // break from some loop
                    }
                });
                self.throttle.cachedGetObjectsIndex = {};
                const newCachedGetObjects = [];
                self.throttle.cachedGetObjects.some((cachedGetObject) => {
                    if (keepRedisKeys.indexOf(cachedGetObject.redisKey) !== -1) {
                        const newCachedGetObjectsLength = newCachedGetObjects.push(cachedGetObject);
                        self.throttle.cachedGetObjectsIndex[cachedGetObject.redisKey] = newCachedGetObjectsLength - 1; // 0 based
                        self.throttle.cachedGetObjectsAccessLog.push(cachedGetObject.redisKey); // refill this cachedGetObjectsAccessLog array immediately (or if trimCachedGetObjects is called again quickly - during a busy time - it will wrongly conclude that no cached items should be kept)
                        if (newCachedGetObjectsLength === cachedGetObjectsTargetLength) return true; // break from some loop
                    }
                });
                self.throttle.cachedGetObjects = newCachedGetObjects;
                console.log(`cachedGetObjects new length after cleanup: ${self.throttle.cachedGetObjects.length}`)
            },
            clearCachedGetObjects: () => {
                console.log(`Clearing ${self.throttle.cachedGetObjects.length} objects from cachedGetObjects...`);
                self.throttle.cachedGetObjects = [];
                self.throttle.cachedGetObjectsIndex = {};
                self.throttle.cachedGetObjectsAccessLog = [];
            },
            initClearCachedGetObjectsInterval: () => {
                if (self.throttle.clearCachedGetObjectsInterval) return;
                self.throttle.clearCachedGetObjectsInterval = setInterval(() => {
                    self.throttle.clearCachedGetObjects();
                }, self.throttle.clearCachedGetObjectsIntervalTime);
            },

            ////////
            // LRANGE (batched)
            pendingLrangeBatch: {}, // Each key is a JSON stringified representation of the lrange argument signature. Each value is an array of cbacks. { "['word:foo_bar:foundAt',startIndex,endIndex]": [cback, cback, etc], etc... }
            pendingLrangeBatchCount: 0,
            lrange: (key, startIndex, endIndex, cback) => { // ALWAYS returns an array of parsed JSON objects (unlike standard redis Lrange)
                const thisLrangeArgSignature = JSON.stringify([key, startIndex, endIndex]);
                if(!self.throttle.pendingLrangeBatch[thisLrangeArgSignature]) self.throttle.pendingLrangeBatchCount++;
                self.throttle.pendingLrangeBatch[thisLrangeArgSignature] = self.throttle.pendingLrangeBatch[thisLrangeArgSignature] || [];
                self.throttle.pendingLrangeBatch[thisLrangeArgSignature].push(cback);
                if (self.throttle.pendingLrangeBatchCount === self.throttle.maxLrangeBatchSize) self.throttle.lrangeBatch();
            },
            lrangeBatchInterval: null,
            initLrangeBatchInterval: () => {
                if (self.throttle.lrangeBatchInterval) return;
                self.throttle.lrangeBatchInterval = setInterval(() => {
                    self.throttle.lrangeBatch();
                }, self.throttle.lrangeIntervalTime);
            },
            lrangeBatch: () => {
                if (self.throttle.pendingLrangeBatchCount === 0) return;
                const pendingLrangeBatchEntries = Object.entries(self.throttle.pendingLrangeBatch);
                console.log(`Now running batched lrange for ${pendingLrangeBatchEntries.length} lrange signatures...`);
                self.throttle.pendingLrangeBatchCount = 0;
                self.throttle.pendingLrangeBatch = {};
                const batchCmdsArray = [];
                const cbacksByIndex = [];
                for (const [thisLrangeArgSignature, allCbacksForThisLrange] of pendingLrangeBatchEntries) {
                    const lrangeArgs = JSON.parse(thisLrangeArgSignature);
                    lrangeArgs.unshift('lrange');
                    batchCmdsArray.push(lrangeArgs);
                    cbacksByIndex.push(allCbacksForThisLrange);
                }
                self.batch(batchCmdsArray, (res) => {
                    res.forEach((thisListRes, thisListResIndex) => {
                        const cbacksForThisListRes = cbacksByIndex[thisListResIndex];
                        cbacksForThisListRes.forEach((thisLrangeCback) => {
                            if (thisLrangeCback) thisLrangeCback(thisListRes);
                        });
                    });
                });
            },

            ///////
            // Below functions are for manipulating batch records on this self.throttle object
            clearPendingGet: (redisKey) => {
                if (self.throttle.pendingGetBatch[redisKey]) delete self.throttle.pendingGetBatch[redisKey];
            },
            clearPendingSet: (redisKey) => {
                if (self.throttle.pendingSetBatch[redisKey]) delete self.throttle.pendingSetBatch[redisKey];
            }

        };
    } //end attachThrottleFuncs

}

export default RedisClient;
