// Beware: This machine "single" is for running the entire app on a single server computer (redis, uiServer, and ALL other processes)
const redisConfigs = require('../../utils/redisClient-config.js');
const thisRedisConfig = redisConfigs.servers.db();
const redisClientConfigString = `--redisHost=${thisRedisConfig.host} --redisPort=${thisRedisConfig.port} --redisPassword=${thisRedisConfig.password}`;

module.exports = {
    apps : [
        {
            name: 'Redis Server',
            script: '/home/rock/jwebb/downloads/redis-stable/src/redis-server',
            args: `--port ${thisRedisConfig.port} --notify-keyspace-events KEA --requirepass ${thisRedisConfig.password}`
        }, {
            name: 'UI Server',
            script: './processes/uiServer.js',
            args: `${redisClientConfigString}`,
            interpreter_args: '-r esm'
        }, {
            name: 'Fetch Reddit Comments',
            script: './processes/fetchRedditComments.js',
            args: `${redisClientConfigString}`,
            interpreter_args: '-r esm'
        }, {
            name: 'Fetch Stock Symbols',
            script: './processes/fetchCoinAndStockSymbols.js',
            args: `${redisClientConfigString}`,
            interpreter_args: '-r esm'
        }, {
            name: 'Comment Word Extractor',
            script: './processes/extractWordsFromComments.js',
            args: `${redisClientConfigString}`,
            interpreter_args: '-r esm'
        }, {
            name: 'Top Comment Stats',
            script: './processes/topCommentStats.js',
            args: `${redisClientConfigString}`,
            interpreter_args: '-r esm'
        }
    ]
}
