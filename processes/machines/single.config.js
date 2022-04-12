// A pm2 process config - https://pm2.keymetrics.io/docs/usage/application-declaration/
// Beware: This machine "single" is for running the all app processes on a single server computer (redis, uiServer, and ALL other processes)
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import pm2 from 'pm2';
import redisConfigs from '../../utils/redisClient-config.js';

const rdbDir = path.resolve(process.cwd(), '../hashHype_persist/db');
const logDir = path.resolve(process.cwd(), '../hashHype_persist/logs');
// Ensure all required directorties exist on local machine
fs.mkdirSync(rdbDir, {recursive: true}); // recursive will allow this command to not error if dir already exists
fs.mkdirSync(logDir, {recursive: true});

const activeLogDayTstamp = '00000'; // A tstamp of zero is always used for active pm2 logs. MaintainLogsAndBackups will rotate for us into archivable day tstamps (and upload to gdrive).

const processKillTimeout = 240000; //ms. Allow processes 4 minutes to gracefully shutdown before pm2 force kills them.

const argv = yargs(process.argv.slice(2)).argv;
if (!argv.host_redis_dbs) argv.host_redis_dbs = '["short","long"]';
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
                name: `redis_${thisRedisConfig.dbName}`, // SEE note *1 below
                script: thisRedisConfig.hostInfo.redisServerPath,
                args: `${redisServerConfigString}`,
                error_file: genConfigs.getLogPath(`redis-${thisRedisConfig.dbName}`, 'err'),
                out_file: genConfigs.getLogPath(`redis-${thisRedisConfig.dbName}`, 'out'),
                kill_timeout : processKillTimeout, // give redis plenty of time to shutdown when pm2 kills it so that it can save a final RDB (4 minutes)
                listen_timeout : processKillTimeout,
                killPriority: 1, // killPriority tells deployCodeSftp the order that "pm2 stop ${appName}" should be called when doing a full restart. Any items with an undefined killPriority will be stopped first, all at once async. Then, will increase by one until no more apps are left. Any apps with the same killPriority will be stopped together async in the same 'pm2 stop' command.
            });
        });

        return allRedisServerProcessConfigs;
    }, // end 'dbs'

    apps: () => {
        const host_redis_dbsJson = JSON.stringify(argv.host_redis_dbs);
        return [
            {
                name: 'archiveKeysToDisk',
                script: './processes/archiveKeysToDisk.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}' --levelDBMaster=true  --redisDBMaster=true`,
                error_file: genConfigs.getLogPath('archiveKeys', 'err'),
                out_file: genConfigs.getLogPath('archiveKeys', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'uiServer',
                script: './processes/uiServer.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                error_file: genConfigs.getLogPath('uiServer', 'err'),
                out_file: genConfigs.getLogPath('uiServer', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            },
            {
                name: 'fetchCoinAndStockSymbols',
                script: './processes/fetchCoinAndStockSymbols.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                error_file: genConfigs.getLogPath('stockSymbols', 'err'),
                out_file: genConfigs.getLogPath('stockSymbols', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'extractWordsFromComments',
                script: './processes/extractWordsFromComments.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                error_file: genConfigs.getLogPath('wordExtractor', 'err'),
                out_file: genConfigs.getLogPath('wordExtractor', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'topCommentStats',
                script: './processes/topCommentStats.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                error_file: genConfigs.getLogPath('topComments', 'err'),
                out_file: genConfigs.getLogPath('topComments', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'topTrendStats',
                script: './processes/topTrendStats.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                error_file: genConfigs.getLogPath('topTrends', 'err'),
                out_file: genConfigs.getLogPath('topTrends', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : processKillTimeout,
                listen_timeout : processKillTimeout,
            }, {
                name: 'maintainLogsAndBackups',
                script: './processes/maintainLogsAndBackups.js',
                args: `--envname=${argv.envname} --host_redis_dbs='${host_redis_dbsJson}'`,
                error_file: genConfigs.getLogPath('maintenance', 'err'),
                out_file: genConfigs.getLogPath('maintenance', 'out'),
                log_date_format: 'MM/DD HH:mm:ss',
                kill_timeout : 1200000, // this process gets a full 20 minutes before force kill (RDB file uploads take a long time and can't be interupted)
                listen_timeout : processKillTimeout,
            }
        ];
    }, // end 'apps'

    getLogPath: (procName, logType) => {
        return `${logDir}/${argv.envname}-${activeLogDayTstamp}-${procName}-${logType}.log`;
    },

    runPm2start: () => {
        const pm2Config = genConfigs.dbs().concat(genConfigs.apps());
        pm2.connect(function(err) {
            if (err) console.error(err);
            pm2.start(pm2Config, (err, apps) => {
                if (err) console.error(err);
                pm2.disconnect();
            })
        })
    }

}; // end genConfigs

if (argv.pm2start) genConfigs.runPm2start();
export default genConfigs;

// To debug a process on a remote maching run:
// npm run debug --target=dev01 --procname=uiServer
// NOTE: the procname will then hold port 9229 busy until the process is manually stopped (can't run the debug command on another procname until prev one is killed).
//       The produced ssh connection terminal must remain open to continue piping process output to local debugger.

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
