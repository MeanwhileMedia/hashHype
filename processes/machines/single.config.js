// Beware: This machine "single" is for running the all app processes on a single server computer (redis, uiServer, and ALL other processes)
const path = require('path');
const redisConfigs = require('../../utils/redisClient-config.js');
const logDir = path.resolve(process.cwd(), 'utils/logs');
const logDay = Math.floor(Date.now() / 86400000);

const getLogPath = (procName, logType) => {
    return `${logDir}/${procName}-${logType}-${logDay}.log`;
};

const genConfigs = {

    allDbClientConfigs: {}, // all configs added to this array in below dbs function are then passed to each individual app process as the "--dbs" arg (a base64 encoded JSON string)
    dbs: () => {
        const allRedisServerProcessConfigs = [];
        [redisConfigs.servers.short(), redisConfigs.servers.long()].forEach((thisRedisConfig) => {
            genConfigs.allDbClientConfigs[thisRedisConfig.dbName] = {
                dbName: thisRedisConfig.dbName,
                redisHost: thisRedisConfig.hostInfo.address,
                redisPort: thisRedisConfig.serverArgs.port,
                redisPassword: thisRedisConfig.serverArgs.requirepass,
                storeNamespaces: thisRedisConfig.storeNamespaces
            };

            let redisServerConfigString = '';
            for (const [key, value] of Object.entries(thisRedisConfig.serverArgs)) {
              redisServerConfigString = `${redisServerConfigString} --${key} ${value}`
            }
            allRedisServerProcessConfigs.push({
                name: `Redis Server (${thisRedisConfig.dbName})`, // SEE note *1 below
                script: thisRedisConfig.hostInfo.redisServerPath,
                args: `${redisServerConfigString}`,
                kill_timeout : 5000, // give redis time to shutdown when pm2 kills it
                listen_timeout : 5000, // give redis time to fully start before pm2 thinks something is wrong
                error_file: getLogPath(`redis-${thisRedisConfig.dbName}`, 'err'),
                out_file: getLogPath(`redis-${thisRedisConfig.dbName}`, 'out'),
            });
        });

        return allRedisServerProcessConfigs;
    }, // end 'dbs'

    apps: () => {
        const dbsJson = JSON.stringify(genConfigs.allDbClientConfigs);
        const buffer = new Buffer(dbsJson);
        const dbsJsonBase64Encoded = buffer.toString('base64');

        const cliArgs = genConfigs.extractCliArgs();
        let inspect = '';
        if (cliArgs.inspect) inspect = '--inspect';

        return [
            {
                name: 'UI Server',
                script: './processes/uiServer.js',
                args: `--dbs=${dbsJsonBase64Encoded}`,
                interpreter_args: '-r esm',
                error_file: getLogPath('uiServer', 'err'),
                out_file: getLogPath('uiServer', 'out'),
            }, {
                name: 'Fetch Reddit Comments',
                script: './processes/fetchRedditComments.js',
                args: `--dbs=${dbsJsonBase64Encoded}`,
                interpreter_args: '-r esm',
                error_file: getLogPath('fetchReddit', 'err'),
                out_file: getLogPath('fetchReddit', 'out')
            }, {
                name: 'Fetch Stock Symbols',
                script: './processes/fetchCoinAndStockSymbols.js',
                args: `--dbs=${dbsJsonBase64Encoded}`,
                interpreter_args: '-r esm',
                error_file: getLogPath('stockSymbols', 'err'),
                out_file: getLogPath('stockSymbols', 'out')
            }, {
                name: 'Comment Word Extractor',
                script: './processes/extractWordsFromComments.js',
                args: `--dbs=${dbsJsonBase64Encoded}`,
                interpreter_args: '-r esm',
                error_file: getLogPath('wordExtractor', 'err'),
                out_file: getLogPath('wordExtractor', 'out')
            }, {
                name: 'Top Comment Stats',
                script: './processes/topCommentStats.js',
                args: `--dbs=${dbsJsonBase64Encoded}`,
                interpreter_args: `-r esm ${inspect}`,
                error_file: getLogPath('topComments', 'err'),
                out_file: getLogPath('topComments', 'out')
            }
        ];
    }, // end 'apps'

    extractCliArgs: () => {
        const cliArgsDefaults = {
            // pass the "-- --inspect" cli arg to the pm2 start command to launch the node process in debug mode. To read the output remotely, start a new ssh tunnel:
            // ssh -L 9221:localhost:9229 -p 8122 ubuntu@dev.meanwhile.media (where localhost:9221 is the local port that chrome dev tools will
            // connect to, and 9229 is the port which was assigned to the node process on the remote host machine).
            inspect: false,
        };
        process.argv.forEach((thisArgv) => {
            if (thisArgv === '--inspect') cliArgsDefaults.inspect = true;
        });
        return cliArgsDefaults;
    }

}; // end genConfigs

// Export it in pm2 config format
module.exports = {
    apps : genConfigs.dbs().concat(genConfigs.apps())
};


// *1. Must add the following changes to bottom of /etc/sysctl.conf
//     vm.overcommit_memory=1
//     net.core.somaxconn=65535
//
// *2. Steps to init new raspberry pi 4 machine:
//     - install ubuntu to card, boot first time with keyboard and monitor. Perform first login (then can be added to POE/ethernet and accessed via SSH)
//     - sudo apt update
//     - sudo apt upgrade
//     - for a maching that will run redis - sudo apt install build-essential
//     - for a maching that will run redis - perform *1 above
//     - install node (nvm) and redis (https://redis.io/topics/quickstart)
