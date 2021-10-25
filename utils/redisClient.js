import redis from 'redis';
import yargs from 'yargs';
import redisClientConfig from './redisClient-config.js';

// This extends wraps node_redis functionality. It hanldles multiple database configs, offers throttled functionality +more.
class RedisClient {
    constructor(opts) {
        const self = this;
        this.clients = null;
        this.redisDbConfigs = this.getRedisDbConfigs();
        this.initAllClients(() => {
            self.attachThrottleFuncs();
            self.throttle.initSetBatchInterval();
            self.throttle.initGetBatchInterval();
            self.throttle.initLrangeBatchInterval();
            self.throttle.initClearCachedGetObjectsInterval();
            if (opts.onConnect) opts.onConnect();
        });
    }

    getRedisDbConfigs() {
        // Extract and normalize just certain properties from our redisClient-config file (the properties needed to connect a new db client).
        const redisDbConfigs = {};
        [redisClientConfig.servers.short(), redisClientConfig.servers.long()].forEach((thisRedisConfig) => {
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
        const storeToDbs = [];
        const preserveToDbs = [];
        for (const [thisDbName, thisDbConfig] of Object.entries(self.redisDbConfigs)) {
            // 1. find matching thisDbConfig.storeNamespaces for this key
            if (!Array.isArray(thisDbConfig.storeNamespaces) || thisDbConfig.storeNamespaces.length === 0) continue;
            thisDbConfig.storeNamespaces.some((storeConf) => {
                if ( new RegExp(storeConf.pattern).test(commandArgs.key) ) {
                    storeConf.dbName = thisDbConfig.dbName;
                    storeToDbs.push(storeConf);
                    return true; // break some loop
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
                    if (execCback) execCback(redisRes);
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
                        if (redisRes) console.log(`Could not find redis key in primary DB. Recovered ${commandArgs.key} from preserved data in "${thisPreserveConf.dbName}" DB.`);
                        if (execCback) execCback(redisRes);
                        if (thisPreserveConf.ttl) self.pexpire(commandArgs.key, thisPreserveConf.ttl, null, thisPreserveConf.dbName);
                    };
                    self[commandArgs.command].apply(self, commandArgs.reformCommandArgs());
                });
            });
            let curCmdExecIndex = 0;
            const nextCmdExec = (thisCmdExec) => {
                thisCmdExec((redisRes) => {
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
                    if (origCback) origCback(redisRes);
                });
            };
            const combinedCmdExecs = commandExecs.concat(preserveToExecs);
            nextCmdExec(combinedCmdExecs[curCmdExecIndex]);
        } else {
            // If this is not a isReadOp command, and we just need to write to multiple DBs, then run all promises concurrently and execute provided cback once they all resolve.
            let didCallOrigCback = false; // we are gonna call this asap (with the first response from our set of commandExecs)
            commandExecs.forEach((thisCmdExec) => {
                thisCmdExec((redisRes) => {
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
                                if (commandArgs.command !== 'del') { // the del command should always run on all DBS (including preserved) or else there will be a delete/recover loop
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
                    if (commandArgs.command === 'rpush') {
                        // rpush returns the new list length in it's response. Compare this number to the configured preserveNamespaces.count param and re-save.
                        const redisListLength = redisRes;
                        preserveToNow(redisListLength);
                        // rpush will create a new list if it does not yet exist. If this write command was against a key that got nuked from redis "short", the rpush
                        // will wrongly succeed, and any future read commands against this key will also succeed with returning partial data (instead of falling back to recovering
                        // the preseved data). Therefore, we will now attempt to sync presevered -> primary db ONLY IF this redisListLength was 1 (new list just created).
                        if (redisListLength === 1) {
                            const usePreserveToConfig = preserveToDbs[0]; // assume that if this key was configured to preserve to more than 1 db (rare), that they will all be in sync. Just use the first one.
                            self.lrange(commandArgs.key, 0, -1, (resList) => {
                                if (resList.length <= 1) return; // looks like this actually is a new list. Nothing was found in preserved DB.
                                self.rpush(commandArgs.key, resList);
                                console.log(`Restored ${commandArgs.key} redis list (length ${resList.length}) from preserved DB "${usePreserveToConfig.dbName}".`);
                            }, usePreserveToConfig.dbName);
                        }
                    }
                    if (commandArgs.command === 'zadd') { // JWW stopping - this has not been tested
                        // Follows nearly identical logic to above rpush
                        const redisSortedSetLength = redisRes;
                        preserveToNow(redisSortedSetLength);
                        if (redisSortedSetLength === 1) {
                            const usePreserveToConfig = preserveToDbs[0];
                            self.zrange(commandArgs.key, 0, Infinity, (resSet) => {
                                if (resSet.length <= 1) return; // looks like this actually is a new list. Nothing was found in preserved DB.
                                self.zadd(commandArgs.key, resSet.reverse()); // zadd expects the reverse arg sig to what zrange returns [points1, val1, points2, val2]
                                console.log(`Restored ${commandArgs.key} redis sorted set (length ${resSet.length/2}) from preserved DB "${usePreserveToConfig.dbName}".`);
                            }, usePreserveToConfig.dbName, 'WITHSCORES');
                        }
                    }
                    if (commandArgs.command === 'set' && commandArgs.saveData) {
                        // the extended set command (see below) automatically increments a "saveCount" integer every time the same object is saved. Compare that number to the configured preserveNamespaces.count param and re-save.
                        preserveToNow(commandArgs.saveData.saveCount || 0);
                    }
                    if (commandArgs.command === 'del') {
                        preserveToNow(0);
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
            isReadOp: false, // if this is a get, lrange, etc, where a return value is expected in cback, then isReadOp will be true.
            key: null, // will not be defined in the case of batch commands (batch/mget/mset/etc)
            saveData: null, // string (set), array (zadd), array (zrem). will only be defined for write operations.
            startIndex: null, // int. will only be defined for certain list commands (lrange, ltrim)
            endIndex: null, // int. will only be defined for certain list commands (lrange, ltrim)
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
        if (cmdArgsObj.command === 'rpush') {
            cmdArgsObj.isReadOp = false;
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
            self.throttle.clearPendingSet(normalizedArgs.key); // Some of our logic will bypass throttling so any pending throttled sets need to be cleared now.
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

    //////////
    // Extended list functions DO NOT auto stringify/parse redis data. (that feature is only for redis string commands)
    // These list functions will attempt to read/write data exactly as it comes from/to redis. (for example, tstamps in lists are returned as strings!)
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
    // These list functions will attempt to read/write data exactly as it comes from/to redis. (for example, tstamps in lists are returned as strings!)
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

    ////////
    // Up next, Sorted Set commands. This structure is used by index:wordToComments to maintain an ordered list of commentIds which
    // are scored using their createdAt tstamps. zrange can be used to extract onlt commentIds which fall in a certain timerange.
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
            setIntervalTime: 2000, // stagger these so our intervals don't all hit simultaneously
            maxSetBatchSize: 100, // total number of callbacks that would need to be registed to all set keys to trigger the redis request
            getIntervalTime: 900,
            maxGetBatchSize: 200,
            lrangeIntervalTime: 1000,
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
                        const mgetResForThisKey = resArray[thisKeyIndex];;
                        const cbacksForThisKey = mgetCbacks[key];
                        if (!cbacksForThisKey || cbacksForThisKey.length === 0) return;
                        const execAllCbacks = (resObj) => {
                            cbacksForThisKey.forEach((thisCback) => {
                                if (typeof thisCback !== 'function') return;
                                thisCback(resObj);
                            });
                        };
                        if (mgetResForThisKey !== null) {
                            execAllCbacks(mgetResForThisKey);
                            return;
                        }
                        // It looks like this key was not found in "short" db and returned null. For the most part, our throttled functions should never touch any dynamic DB logic, however,
                        // throttle.get is the one exception. It will attempt to run a normal redisClient.get for any keys which weren't found in a redisClient.throttle.get
                        // but ONLY after we have returned all non-null responses to passed cbacks and finished/reset our getBatch in a non-blocking way.
                        // console.log(`A throttled.get (mget) returned a null response for key ${key}. Key will now be passed to dynamic DB logic to check if it was preserved to another DB...`);
                        self.get(key, (redisRes) => {
                            execAllCbacks(redisRes);
                        });
                    });
                });
            },

            ////////
            // GET (cached)
            cachedGetObjectsMaxSize: 1000, // only stores the most recently used cached objects
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
                const cachedGetObjectsTargetLength = Math.round(self.throttle.cachedGetObjectsMaxSize * .5); // Free up 50% so we aren't running this cache trimming logic for every single call to getCached (after the cache has filled)
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
