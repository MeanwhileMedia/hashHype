import redis from 'redis';
import yargs from 'yargs';
const cliArgs = yargs(process.argv).argv;

class RedisClient {
    constructor(opts) {
        opts.clientOpts = opts.clientOpts || {};

        this.client = null;
        this.clientOpts = {
            host: opts.clientOpts.host || cliArgs.redisHost,
            port: opts.clientOpts.port || cliArgs.redisPort,
            password: opts.clientOpts.password || cliArgs.redisPassword
        };
        this.onConnect = opts.onConnect || function (client){
            console.log('Redis client connected.');
        };
        this.initClientConnection();
        this.attachHelpersToClient();
    }

    initClientConnection() {
        const self = this;
        this.client = redis.createClient(this.clientOpts);
        this.client.on('connect', function() {
            self.onConnect(self.client);
        });
        this.client.on("error", function(err) {
            console.log('Redis error:', err);
        });
    }

    attachHelpersToClient() {
        this.attachThrottledActions();
    }

    attachThrottledActions() {
        //adds client.throttled.set and client.throttled.get which will batch these redis requests then
        //fire them as mset and mget in an interval (or when the queue reaches a max size).
        const self = this.client;
        self.throttle = {
            setIntervalTime: 5000,
            maxSetBatchSize: 100,
            getIntervalTime: 3000,
            maxGetBatchSize: 100,

            ////////
            // SET
            pendingSetBatch: {}, // {key: object (not yet stringified)}
            pendingSetBatchCount: 0,
            set: (key, object, cback) => { //ONLY pass objects the throttled set, not stringified JSON
                if(!self.throttle.pendingSetBatch[key]) self.throttle.pendingSetBatchCount++;
                self.throttle.pendingSetBatch[key] = object;
                if (self.throttle.pendingSetBatchCount > self.throttle.maxSetBatchSize) self.throttle.setBatch();
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
                if (self.throttle.pendingGetBatchCount > self.throttle.maxGetBatchSize) self.throttle.getBatch();
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
                self.mget(mgetArgs, (err, resArray) => {
                    if(err || !resArray || resArray.length === 0) {
                        console.log(`Could not mget keys from redis:`, mgetArgs, err);
                        return;
                    }
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

        }; //end self.throttle

        self.throttle.initSetBatchInterval();
        self.throttle.initGetBatchInterval();
    }
}

export default RedisClient;
