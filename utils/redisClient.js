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
                self.initClientConnection(clientOpts, (node_redis_client) => {
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
                self.initClientConnection(clientOpts, (node_redis_client) => {
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

    initClientConnection(clientOpts, onConnect) {
        const node_redis_client = redis.createClient(clientOpts);
        node_redis_client.on('connect', function() {
            onConnect(node_redis_client);
        });
        node_redis_client.on("error", function(err) {
            console.warn('Error connectiong node_redis client:', err);
        });
    }

    get(key, cback, dbName = 'short') {
        const self = this;
        self.clients[dbName].db.get(key, (err, json) => {
            if (err) {
                console.warn(err);
                if (cback) cback(null);
                return;
            }
            if (!json) {
                // console.warn(`Could not find redis key: ${key}`);
                if (cback) cback(null);
                return;
            }
            let redisObject = null;
            try {
                redisObject = JSON.parse(json);
            } catch (error) {
                console.warn(`Failed to parse invalid JSON for redis key: ${key}`, error);
                if (cback) cback(null);
                return;
            }
            if (cback) cback(redisObject);
        });
    }

    set(key, redisObj, cback, dbName = 'short') {
        const self = this;
        self.clients[dbName].db.set(key, JSON.stringify(redisObj), (err) => {
            if (err) console.warn(err);
            if (cback) cback();
        });
    }

    mget(mgetArgs, cback, dbName = 'short') {
        const self = this;
        self.clients[dbName].db.mget(mgetArgs, (err, resArray) => {
            if(err || !resArray || resArray.length === 0) {
                console.warn(`Could not mget ${mgetArgs.length} keys from redis`, mgetArgs, err);
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
            if (cback) cback(resObjects);
        });
    }

    mset(msetArgs, cback, dbName = 'short') {
        const self = this;
        self.clients[dbName].db.mset(msetArgs, cback);
    }

    del(key, cback, dbName = 'short') {
        const self = this;
        self.clients[dbName].db.del(key, cback);
    }

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

    attachThrottleFuncs() {
        const self = this;
        //adds client.throttled.set and client.throttled.get which will batch these redis requests then
        //fire them as mset and mget in an interval (or when the queue reaches a max size).
        this.throttle = {
            setIntervalTime: 5000,
            maxSetBatchSize: 100,
            getIntervalTime: 3000,
            maxGetBatchSize: 100, // JWW todo performance - consider increasing this. See logs for long piles of "Now running batched mget (and mset) for 101 keys"

            ////////
            // SET
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
                console.log(`Now running batched mset for ${msetArgs.length/2} keys`);
                self.mset(msetArgs);
                self.throttle.pendingSetBatch = {};
            },

            ////////
            // GET
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

                console.log(`Now running batched mget for ${mgetArgs.length} keys`);
                self.mget(mgetArgs, (resArray) => {
                    if(resArray.length === 0) return;
                    mgetArgs.forEach((key, thisKeyIndex) => {
                        const cbacksForThisKey = mgetCbacks[key];
                        if (!cbacksForThisKey || cbacksForThisKey.length === 0) return;
                        cbacksForThisKey.forEach((thisCback) => {
                            if (typeof thisCback !== 'function') return;
                            let gotObject = resArray[thisKeyIndex];
                            if (typeof gotObject === 'string') gotObject = JSON.parse(gotObject);
                            thisCback(gotObject);
                        });
                    });
                });
            },
            cachedGetObjectsMaxSize: 100, // only stores the most recently used cached objects
            cachedGetObjects: [], // held as an array for quick unshift and splice (to limit cache size)
            cachedGetObjectsIndex: {}, // also maintain an index for increased performance (don't have to loop through array for every getCached request) {'redis:key': int (index within cachedGetObjects array), etc..}
            cachedGetObjectsAccessLog: [], // every time a redis key is returned via getCached (whether from cache, or from redis), it's key is pushed to this array. cachedGetObjectsAccessLog is used to meet cachedGetObjectsMaxSize in an LRU fashion.
            clearCachedGetObjectsIntervalTime: 60000*10, // 10 mins - completely clear out cached get objects in intervals to ensure fresh data in local memory, and to clear out accessLog
            getCached: (redisKey, cback) => { // ALWAYS returns a JSON parsed object to cback
                // Can use this function to get an object but then hold it in local live memory. If getCached
                // is called again for same key, the live object is returned immediately. This function is useful
                // for data that is requested frequently, but does not change in redis frequently. (big performance
                // gain for speed and memory because we aren't holding a ton of node_redis queue items in memory).
                const cachedObjectIndex = self.throttle.cachedGetObjectsIndex[redisKey];
                if (typeof cachedObjectIndex === 'number' && self.throttle.cachedGetObjects[cachedObjectIndex]) {
                    const cachedObject = self.throttle.cachedGetObjects[cachedObjectIndex];
                    if (cback) cback(cachedObject);
                    // console.log(`Got a cached object from cachedGetObjects: ${redisKey} -> ${cachedObject.redisKey}`);
                    self.throttle.cachedGetObjectsAccessLog.push(redisKey);
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
                    console.log(`Got an object from redis and will now hold in cachedGetObjects: ${redisKey}. Cache size: ${cachedGetObjectsLength}/${self.throttle.cachedGetObjectsMaxSize}`);
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
