// This config sets redis config options
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to redisClient-config.js (which is gitignored)
import path from 'path';

const config = {

    // Because server configs are passed to every process as cli args, all data here must be jsonable.
    servers: {

        short: () => { // short term memory store
            return {
                dbName: 'short', // a hashHype app requires one dbName to be "short" as this is the default for redisClient.throttled functions and is used a general purpose memory store
                hostInfo: {
                    address: '',
                    remoteAddress: null, // set this ONLY if this DB can be connected to remotely by other machines (see redisClient.initRemoteClient)
                    redisServerPath: '',
                },
                storeNamespaces: [  // try to keep the most frequently matched patterns first in array for increased performance. Or match logic loop returns on first match.
                    // When a .set is called for a redis key, if that key matches any of the configured 'storeNamespaces' patterns, then it is stored to this database AND any other database with matching pattern.
                    {
                        pattern: '.', // This should not be changed for "short. Everything is stored to the "short" term memory store. If our semi aggressive LRU policy nukes the wrong item, redisClient.js will automatically try to recover it from the other databases which have a matching storeNamespaces pattern.
                        ttl: null // milliseconds. set this to null and no expire will be set for objects matching this pattern. NOTE: if this is set, the pexpire command is run upon every read/write if matched key (cpu/memory overhead)

                    },
                    // {
                    //     pattern: '^word:.+:foundAt$',
                    //     ttl: null,
                    //     isMatch: (commandArgs, redisClient) => {
                    //         let matched = true;
                    //         // add additional logic to determine whether this key should/not be written/read from this DB
                    //         return matched;
                    //     },
                    //     onComplete: (commandArgs, redisRes, redisClient) => {
                    //         // add additional logic to determine if this DB action should trigger another event
                    //     }
                    // }
                ],
                // preserveNamespaces: [], // This config is not applicable to the "short" db. See below for docs on how to use "preserveNamespaces".
                serverArgs: { // mapped directly to redis cli config prop names
                    port: 8170,

                    // Auth settings
                    requirepass: '',

                    // Persistence settings
                    dbfilename: '00000-short.rdb', // To utilize db archive/backup functionality (in maintainLogsAndBackups) the rdb file name MUST always start with the "active day tstamp" 00000. Our maintenance process automatically prepends the envname to the beginning of the filename.
                    dir: path.resolve(process.cwd(), '../hashHype_persist/db/'),
                    save: '600 1', // save an rdb snapshot every 600 seconds (10 minuites) if there was at least 1 change to db.
                    // appendonly: 'yes',
                    // appendfilename: 'persistDb.aof',

                    // Memory settings
                    maxmemory: '900mb',
                    'maxmemory-policy': 'allkeys-lru',
                    'maxmemory-samples': 5,

                    // Pubsub settings
                    'notify-keyspace-events': 'K$z',

                    // Buffer limits. HashHype sets pubsub higher than default to allow for more data to be sent in messages. (redis default is 'pubsub 32mb 8mb 60')
                    'client-output-buffer-limit': 'pubsub 1024mb 256mb 60',

                    // Redis should not block all commands if the latest RDB snapshot failed. We will count on the next snapshot succeeding and let the app continue as normal.
                    'stop-writes-on-bgsave-error': 'no'
                }
            }
        },
        long: () => { // long term memory store. much stricter LRU rules. This db is also backed up to cloud and holds Daily 'stats:...' object snapshots
            return {
                dbName: 'long',
                hostInfo: {
                    address: '',
                    remoteAddress: null,
                    redisServerPath: '',
                },
                storeNamespaces: [],
                serverArgs: {
                    port: 8171,

                    // Auth settings
                    requirepass: '',

                    // Persistence settings
                    dbfilename: '00000-long.rdb',
                    dir: path.resolve(process.cwd(), '../hashHype_persist/db/'),
                    save: '480 1', // save every 8 minutes. Offset from the short db snapshot interval so they aren't both using the disk at the same time.
                    // appendonly: 'yes',
                    // appendfilename: 'persistDb.aof',

                    // Memory settings
                    maxmemory: '1100mb',
                    'maxmemory-policy': 'volatile-lru', // evict keys by trying to remove the less recently used (LRU) keys first, but ONLY among keys that have an expire set.
                    'maxmemory-samples': 10,

                    // Pubsub settings
                    'notify-keyspace-events': 'Ee', // long listens for eviction events to sync index records with DB state

                    // Buffer limits. HashHype sets pubsub higher than default to allow for more data to be sent in messages. (redis default is 'pubsub 32mb 8mb 60')
                    'client-output-buffer-limit': 'pubsub 1024mb 256mb 60',

                    // Redis should not block all commands if the latest RDB snapshot failed. We will count on the next snapshot succeeding and let the app continue as normal.
                    'stop-writes-on-bgsave-error': 'no'
                }
            }
        },

    }

};

export default config;
