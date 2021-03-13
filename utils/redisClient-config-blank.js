// This config sets redis config options
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to redisClient-config.js (which is gitignored)

module.exports = { // this file is in cjs format because it's imported by a pm2 config.js

    servers: {
        db: () => {
            return {
                redisServerPath: '', // '/path/to/redis-stable/src/redis-server'.
                host: '',
                port: 0,
                password: '',
            }
        },
    }

};
