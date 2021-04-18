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
                // When a .set is called for a redis key, if that key matches any of the configured 'storeNamespaces' patterns, then it is stored to this database AND any
                // other database with matching pattern. Each string here is merged into a single regex: ['^foo:bar:', '^baz:'] becomes /^foo:bar:|^baz:/
                storeNamespaces: [
                    '.', // This should not be changed for "short. Everything is stored to the "short" term memory store. If our semi aggressive LRU policy nukes the wrong item, redisClient.js will automatically try to recover it from the other databases which have a matching storeNamespaces pattern.
                ],
                serverArgs: { // mapped directly to redis cli config prop names
                    port: 8170,

                    // Auth settings
                    requirepass: '',

                    // Persistence settings
                    dbfilename: 'dbShort.rdb',
                    dir: path.resolve(process.cwd(), './utils/db/'),
                    // appendonly: 'yes',
                    // appendfilename: 'persistDb.aof',

                    // Memory settings
                    maxmemory: '2gb',
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
                serverArgs: {
                    port: 8171,

                    // Auth settings
                    requirepass: '',

                    // Persistence settings
                    dbfilename: 'dbLong.rdb',
                    dir: path.resolve(process.cwd(), './utils/db/'),
                    // appendonly: 'yes',
                    // appendfilename: 'persistDb.aof',

                    // Memory settings
                    maxmemory: '2gb',
                    'maxmemory-policy': 'volatile-lru', // evict keys by trying to remove the less recently used (LRU) keys first, but ONLY among keys that have an expire set.
                    'maxmemory-samples': 10,

                    // Pubsub settings
                    'notify-keyspace-events': 'K$l'
                }
            }
        },

    }

};
