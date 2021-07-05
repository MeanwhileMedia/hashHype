// This config sets redis config options
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to redisClient-config.js (which is gitignored)
const path = require('path');

module.exports = {

    // Because server configs are passed to every process as cli args, all data here must be jsonable.
    servers: {

        short: () => { // short term memory store
            return {
                dbName: 'short', // a hashHype app requires one dbName to be "short" as this is the default for redisClient.throttled functions and is used a general purpose memory store
                hostInfo: {
                    address: '',
                    redisServerPath: '',
                },
                storeNamespaces: [
                    // When a .set is called for a redis key, if that key matches any of the configured 'storeNamespaces' patterns, then it is stored to this database AND any other database with matching pattern.
                    {
                        pattern: '.', // This should not be changed for "short. Everything is stored to the "short" term memory store. If our semi aggressive LRU policy nukes the wrong item, redisClient.js will automatically try to recover it from the other databases which have a matching storeNamespaces pattern.
                        ttl: null // milliseconds. set this to null and no expire will be set for objects matching this pattern
                    }
                ],
                preserveNamespaces: [], // This config is not applicable to the "short" db. See below for docs on how to use "preserveNamespaces".
                serverArgs: { // mapped directly to redis cli config prop names
                    port: 8170,

                    // Auth settings
                    requirepass: '',

                    // Persistence settings
                    dbfilename: '00000-short.rdb', // To utilize db archive/backup functionality (in maintainLogsAndBackups) the rdb file name MUST always start with the "active day tstamp" 00000
                    dir: path.resolve(process.cwd(), './utils/db/'),
                    // appendonly: 'yes',
                    // appendfilename: 'persistDb.aof',

                    // Memory settings
                    maxmemory: '1gb',
                    'maxmemory-policy': 'allkeys-lru',
                    'maxmemory-samples': 5,

                    // Pubsub settings
                    'notify-keyspace-events': 'K$l'
                }
            }
        },
        long: () => { // long term memory store. much stricter LRU rules. This db is also backed up to cloud and holds Daily 'stats:...' object snapshots
            return {
                dbName: 'long',
                hostInfo: {
                    address: '',
                    redisServerPath: '',
                },
                storeNamespaces: [],
                preserveNamespaces: [
                    // preserveNamespaces is similar to storeNamespaces in that you define namespace patterns for dynamic DB logic. However, these patterns are for determining
                    // when a key, just saved to ANY DB, should also be stored to THIS DB. E.g. a redis list of word foundAt tstamps reaches a certain length, we assume it's a popular
                    // word and that it's record must be safely preserved in the event our "short" database gets nuked by redis' aggressive LRU eviction. When a read command attempts to find
                    // that key in "short" and gets a null response, redisClient will automatically retry on this DB - then return the preserved data.
                    // {
                    //     pattern: '^word:.+:foundAt$',
                    //     // "count" is a generic descriptor of the threshhold for when a matched key must be preserved.
                    //     // In the case of redis lists, our preserve logic will compare "count" to the list length. Other redis object types may use "count" differently in preserve logic.
                    //     // In the case of redis strings (json), our preserve logic will compare "count" the the json.saveCount property (incremented upon every call to redisClient.set).
                    //     count: 100,
                    //     ttl: null // milliseconds. set this to null and no expire will be set for objects matching this pattern
                    // }
                ],
                serverArgs: {
                    port: 8171,

                    // Auth settings
                    requirepass: '',

                    // Persistence settings
                    dbfilename: '00000-long.rdb',
                    dir: path.resolve(process.cwd(), './utils/db/'),
                    // appendonly: 'yes',
                    // appendfilename: 'persistDb.aof',

                    // Memory settings
                    maxmemory: '1gb',
                    'maxmemory-policy': 'volatile-lru', // evict keys by trying to remove the less recently used (LRU) keys first, but ONLY among keys that have an expire set.
                    'maxmemory-samples': 10,

                    // Pubsub settings
                    'notify-keyspace-events': 'K$l'
                }
            }
        },

    }

};
