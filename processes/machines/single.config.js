// A pm2 process config - https://pm2.keymetrics.io/docs/usage/application-declaration/
// Beware: This machine "single" is for running the all app processes on a single server computer (redis, uiServer, and ALL other processes)
const fs = require('fs');
const path = require('path');
const redisConfigs = require('../../utils/redisClient-config.js');

const rdbDir = path.resolve(process.cwd(), 'utils/db');
const logDir = path.resolve(process.cwd(), 'utils/logs');
const activeLogDayTstamp = '00000'; // A tstamp of zero is always used for active pm2 logs. MaintainLogsAndBackups will rotate for us into archivable day tstamps (and upload to gdrive).

const processKillTimeout = 240000; //ms. Allow processes 4 minutes to gracefully shutdown before pm2 force kills them.

// Ensure all required directorties exist on local machine
fs.mkdirSync(rdbDir, {recursive: true}); // recursive will allow this command to not error if dir already exists
fs.mkdirSync(logDir, {recursive: true});

const genConfigs = {

    // allDbClientConfigs: {}, // all configs added to this array in below dbs function are then passed to each individual app process as the "--dbs" arg (a base64 encoded JSON string)
    dbs: () => {
        const allRedisServerProcessConfigs = [];
        [redisConfigs.servers.short(), redisConfigs.servers.long()].forEach((thisRedisConfig) => {
            let redisServerConfigString = '';
            for (let [key, value] of Object.entries(thisRedisConfig.serverArgs)) {
                // If this is the redis config "dbfilename", we must also prepend the envname at this point.
                if (key === 'dbfilename') value = `${genConfigs.cliArgs.envname}-${value}`;
                redisServerConfigString = `${redisServerConfigString} --${key} ${value}`;
            }
            allRedisServerProcessConfigs.push({
                name: `Redis Server (${thisRedisConfig.dbName})`, // SEE note *1 below
                script: thisRedisConfig.hostInfo.redisServerPath,
                args: `${redisServerConfigString}`,
                error_file: genConfigs.getLogPath(`redis-${thisRedisConfig.dbName}`, 'err'),
                out_file: genConfigs.getLogPath(`redis-${thisRedisConfig.dbName}`, 'out'),
                kill_timeout : processKillTimeout, // give redis plenty of time to shutdown when pm2 kills it so that it can save a final RDB (4 minutes)
                listen_timeout : processKillTimeout,
            });
        });

        return allRedisServerProcessConfigs;
    }, // end 'dbs'

    apps: () => {
        let inspect = '';
        if (genConfigs.cliArgs.inspect) inspect = '--inspect';

        return [
            {
                name: 'Archive Keys To Disk',
                script: './processes/archiveKeysToDisk.js',
                args: `--envname=${genConfigs.cliArgs.envname} --levelDBMaster=true`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('archiveKeys', 'err'),
                out_file: genConfigs.getLogPath('archiveKeys', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'UI Server',
                script: './processes/uiServer.js',
                args: `--envname=${genConfigs.cliArgs.envname}`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('uiServer', 'err'),
                out_file: genConfigs.getLogPath('uiServer', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'Fetch Reddit Comments',
                script: './processes/fetchRedditComments.js',
                args: `--envname=${genConfigs.cliArgs.envname}`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('fetchReddit', 'err'),
                out_file: genConfigs.getLogPath('fetchReddit', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'Fetch Stock Symbols',
                script: './processes/fetchCoinAndStockSymbols.js',
                args: `--envname=${genConfigs.cliArgs.envname}`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('stockSymbols', 'err'),
                out_file: genConfigs.getLogPath('stockSymbols', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'Extract Words From Comments',
                script: './processes/extractWordsFromComments.js',
                args: `--envname=${genConfigs.cliArgs.envname}`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('wordExtractor', 'err'),
                out_file: genConfigs.getLogPath('wordExtractor', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'Top Comment Stats',
                script: './processes/topCommentStats.js',
                args: `--envname=${genConfigs.cliArgs.envname}`,
                interpreter_args: `-r esm ${inspect}`,
                error_file: genConfigs.getLogPath('topComments', 'err'),
                out_file: genConfigs.getLogPath('topComments', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'Top Trend Stats',
                script: './processes/topTrendStats.js',
                args: `--envname=${genConfigs.cliArgs.envname}`,
                interpreter_args: `-r esm ${inspect}`,
                error_file: genConfigs.getLogPath('topTrends', 'err'),
                out_file: genConfigs.getLogPath('topTrends', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'Maintain Logs And Backups',
                script: './processes/maintainLogsAndBackups.js',
                args: `--envname=${genConfigs.cliArgs.envname}`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('maintenance', 'err'),
                out_file: genConfigs.getLogPath('maintenance', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : 1200000, // this process gets a full 20 minutes before force kill (RDB file uploads take a long time and can't be interupted)
                listen_timeout : processKillTimeout,
            }
        ];
    }, // end 'apps'

    cliArgs: {},
    extractCliArgs: () => {
        const cliArgsDefaults = {
            // pass the "-- --inspect" cli arg to the pm2 start command to launch the node process in debug mode. e.g: npm run single -- -- --inspect
            // To read the output remotely, start a new ssh tunnel:
            // ssh -L 9221:localhost:9229 -p 8122 ubuntu@dev.meanwhile.media (where localhost:9221 is the local port that chrome dev tools will
            // connect to, and 9229 is the port which was assigned to the node process on the remote host machine).
            inspect: false,
            envname: '', // dev01, prod02, etc. Is required.
        };
        process.argv.forEach((thisArgv) => {
            if (thisArgv === '--inspect') cliArgsDefaults.inspect = true;
            if (thisArgv.indexOf('--envname') !== -1) {
                cliArgsDefaults.envname = thisArgv.replace('--envname=', '');
            }
        });

        // Confirm required args are present
        if (!cliArgsDefaults.envname) {
            console.error(`ERR! The '--envname' cli arg is required when starting a new process machine. Script will now exit...`);
            process.exit(1);
        }

        genConfigs.cliArgs = cliArgsDefaults;
        return genConfigs.cliArgs;
    },

    getLogPath: (procName, logType) => {
        return `${logDir}/${genConfigs.cliArgs.envname}-${activeLogDayTstamp}-${procName}-${logType}.log`;
    }

}; // end genConfigs

genConfigs.extractCliArgs(); // will raise errors and quit if required args are missing.

// Export it in pm2 config format
module.exports = {
    apps : genConfigs.dbs().concat(genConfigs.apps())
};


// *1. Must add the following changes to bottom of /etc/sysctl.conf
//     vm.overcommit_memory=1
//     net.core.somaxconn=65535
//      JWW - did not need to do this for temple04. Might not be necc anymore.
//
// *2. Steps to init new raspberry pi 4 machine:
//     - install ubuntu to card, plug into POE and configure router (set static ip, SSH service, port forward to SSH).
//     - sudo apt update
//     - sudo apt upgrade
//     - for a machine that will run redis - sudo apt install build-essential
//     - for a machine that will run redis - perform *1 above
//     - install node (nvm) and redis (https://redis.io/topics/quickstart)
//     - sudo apt-get install libleveldb-dev (for a machine that will hold long term archive data in LevelDB)
