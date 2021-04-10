// This config sets redis config options
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to redisClient-config.js (which is gitignored)
const path = require('path');

module.exports = {

    servers: {

        short: () => { // short term memory store
            return {
                dbName: 'short',
                hostInfo: {
                    address: '',
                    redisServerPath: '',
                },
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
                    maxmemory: '3gb',
                    'maxmemory-policy': 'allkeys-lru',
                    'maxmemory-samples': 5,

                    // Pubsub settings
                    'notify-keyspace-events': 'K$'
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
                serverArgs: { // mapped directly to redis cli config prop names
                    port: 8171,

                    // Auth settings
                    requirepass: '',

                    // Persistence settings
                    dbfilename: 'dbLong.rdb',
                    dir: path.resolve(process.cwd(), './utils/db/'),
                    // appendonly: 'yes',
                    // appendfilename: 'persistDb.aof',

                    // Memory settings
                    maxmemory: '3gb',
                    'maxmemory-policy': 'volatile-lru', // evict keys by trying to remove the less recently used (LRU) keys first, but ONLY among keys that have an expire set.
                    'maxmemory-samples': 10,

                    // Pubsub settings
                    'notify-keyspace-events': 'K$'
                }
            }
        },

    }

};
