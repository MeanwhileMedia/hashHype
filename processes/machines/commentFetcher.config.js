// A pm2 process config - https://pm2.keymetrics.io/docs/usage/application-declaration/

// This machine "commentFetcher" is for streaming data from APIs which only allow 1 connection per session (twitter). This single machine get the data then
// saves it to a central location that other machines can access (so those other machines don't actually connect to the third party API).
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const redisConfigs = require('../../utils/redisClient-config.js');

const rdbDir = path.resolve(process.cwd(), '../hashHype_persist/db');
const logDir = path.resolve(process.cwd(), '../hashHype_persist/logs');
// Ensure all required directorties exist on local machine
fs.mkdirSync(rdbDir, {recursive: true}); // recursive will allow this command to not error if dir already exists
fs.mkdirSync(logDir, {recursive: true});

const activeLogDayTstamp = '00000'; // A tstamp of zero is always used for active pm2 logs. MaintainLogsAndBackups will rotate for us into archivable day tstamps (and upload to gdrive).

const processKillTimeout = 240000; //ms. Allow processes 4 minutes to gracefully shutdown before pm2 force kills them.

const argv = yargs(process.argv.slice(5)).argv;
argv.host_redis_dbs = JSON.parse(argv.host_redis_dbs); // These dbs will be hosted by this machine

const genConfigs = {

    dbs: () => {
        const selectedConfigObjs = [];
        argv.host_redis_dbs.forEach((thisDbName) => {
            selectedConfigObjs.push(redisConfigs.servers[thisDbName]());
        });

        const allRedisServerProcessConfigs = [];
        selectedConfigObjs.forEach((thisRedisConfig) => {
            let redisServerConfigString = '';
            for (let [key, value] of Object.entries(thisRedisConfig.serverArgs)) {
                // If this is the redis config "dbfilename", we must also prepend the envname at this point.
                if (key === 'dbfilename') value = `${argv.envname}-${value}`;
                redisServerConfigString = `${redisServerConfigString} --${key} ${value}`;
            }
            allRedisServerProcessConfigs.push({
                name: `redis_${thisRedisConfig.dbName}`,
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
        const host_redis_dbsJson = JSON.stringify(argv.host_redis_dbs);
        return [
            {
                name: 'fetchRedditComments',
                script: './processes/fetchRedditComments.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('fetchReddit', 'err'),
                out_file: genConfigs.getLogPath('fetchReddit', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'fetchTwitterComments',
                script: './processes/fetchTwitterComments.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('fetchTwitter', 'err'),
                out_file: genConfigs.getLogPath('fetchTwitter', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'maintainLogsAndBackups',
                script: './processes/maintainLogsAndBackups.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                interpreter_args: `-r esm`,
                error_file: genConfigs.getLogPath('maintenance', 'err'),
                out_file: genConfigs.getLogPath('maintenance', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }
        ];
    }, // end 'apps'

    getLogPath: (procName, logType) => {
        return `${logDir}/${argv.envname}-${activeLogDayTstamp}-${procName}-${logType}.log`;
    }

}; // end genConfigs

// Export it in pm2 config format
module.exports = {
    apps : genConfigs.dbs().concat(genConfigs.apps())
};
