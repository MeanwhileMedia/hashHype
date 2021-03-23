// This config sets redis config options
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to redisClient-config.js (which is gitignored)
const path = require('path');

module.exports = { // this file is in cjs format because it's imported by a pm2 config.js

    servers: {
        db: () => {
            return {
                hostInfo: {
                    address: '',
                    redisServerPath: '',
                },
                serverArgs: { // mapped directly to redis cli config prop names
                    port: 0,

                    // Auth settings
                    requirepass: '',

                    // Persistence settings
                    dbfilename: 'persistDb.rdb',
                    dir: path.resolve(process.cwd(), './utils/db/'),
                    appendonly: 'yes',
                    appendfilename: 'persistDb.aof',

                    // Memory settings
                    maxmemory: '1gb',
                    'maxmemory-policy': 'allkeys-lru',

                    // Pubsub settings
                    'notify-keyspace-events': 'Ks'
                }
            }
        },
    }

};
