import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import pm2 from 'pm2';
import {google} from 'googleapis';
import RedisClient from '../utils/redisClient.js';
import gDriveConfig from '../utils/googleClient-config.js';

const argv = yargs(process.argv.slice(2)).argv;

const logDir = path.resolve(process.cwd(), 'utils/logs');
const rdbDir = path.resolve(process.cwd(), 'utils/db');
const tstampPosInFilename = 1; // where filename is "dev01-18908-uiServer-out.log", we extract the tstamp portion via fileName.split('-')[tstampPosInFilename];

// This class performs maintenance tasks related to log rotation, DB snapshot backup to cloud, DB health/status
// monitoring and logging, and is a general catch-all for maintenance tasks.
class MaintainLogsAndBackups {
    constructor() {
        const self = this;
        self.googleDriveClient = null;

        self.dbHealthLogInterval = null;
        self.dbHealthLogIntervalTime = 60000*5; // once per 5 minutes. This is a sizeable log

        self.pm2HealthLogInterval = null;
        self.pm2HealthLogIntervalTime = 60000*2; // once per 2 minutes. This is a sizeable log

        self.rotateLogsInterval = null;
        self.rotateLogsIntervalTime = 60000*10; // check every 10mins. Confirm all required local log files exist according to our day tstamp naming pattern. Create a new log file when the day turns. Check logs directory for expired logs to delete from local machine.
        self.rotateRDBInterval = null;
        self.rotateRDBIntervalTime = 60000*10; // check every 10mins. Check db directory for expired rdb files to delete from local machine.

        self.archiveLogsAndRdbForEnvnames = [ // only certain environments should be backing up logs and rdb files to google drive (otherwise we could run out of space)
            'dev01',
            'prod01'
        ];
        self.archiveLogsInterval = null;
        self.archiveLogsIntervalTime = 60000*5; // backup today's log file to cloud once per 5 minutes
        self.archiveRDBInterval = null;
        self.archiveRDBIntervalTime = 60000*30; // backup all redis rdb files to cloud twice/hr. Uses day tstamp naming pattern.

        self.cloudArchiveCleanupInterval = null;
        self.cloudArchiveCleanupIntervalTime = 60000*720; // twice per 24hrs crawl the files backed up to cloud (google drive) - both logs and rdbs. Delete files older than X days.

        self.initRedisClient(() => {
            self.initGoogleDriveClient(() => {
                self.initDbHealthLogInterval();
                self.initPm2HealthLogInterval();
                self.initRotateLogsInterval();
                self.initRotateRDBInterval();
                if (self.archiveLogsAndRdbForEnvnames.indexOf(argv.envname) !== -1) {
                    self.initArchiveLogsInterval();
                    self.initArchiveRDBInterval();
                    self.initCloudArchiveCleanupInterval();
                }
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        this.redisClient = new RedisClient({
            onConnect: () => {
                console.log('Connected new redis sub client for MaintainLogsAndBackups class.');
                if(cback) cback();
            }
        });
    }

    initGoogleDriveClient(cback) {
        const self = this;
        console.log(`Will now auth a new google API client...`);
        const tempCredsFileData = new Uint8Array(Buffer.from(JSON.stringify(gDriveConfig.serviceCreds)));
        const tempCredsFilePath = path.resolve(process.cwd(), 'googleApiServiceCreds.json');
        fs.writeFile(tempCredsFilePath, tempCredsFileData, (err) => {
            if (err) console.log(err);
            const googleClientAuth = new google.auth.GoogleAuth({
                keyFile: tempCredsFilePath,
                scopes: gDriveConfig.serviceScopes,
            });
            self.googleDriveClient = google.drive({
                version: 'v3',
                auth: googleClientAuth
            });
            if(cback) cback();
        });
    }

    initDbHealthLogInterval() {
        const self = this;
        self.redisClient.info('all', function (infoObjArray) {
            // infoObjArray holds "client.server_info" objects for all requested DBs (defaults to run info command on all dbs.)
            if (!infoObjArray || infoObjArray.length === 0) return;
            infoObjArray.forEach((thisDbInfoObj) => {
                console.log(`DB info stats for "${thisDbInfoObj.dbName}" DB at time ${Date.now()} :`, thisDbInfoObj);
            });
        });

        if (self.dbHealthLogInterval) return;
        self.dbHealthLogInterval = setInterval(() => {
            self.initDbHealthLogInterval();
        }, self.dbHealthLogIntervalTime);
    }

    initPm2HealthLogInterval() {
        const self = this;
        pm2.connect((err) => {
            if (err) {
                console.error(err)
                return;
            }
            pm2.list((err, list) => {
                if (err) {
                    console.error(err)
                    return;
                }
                const listSummary = list.map((thisProc) => {
                    return {
                        name: thisProc.name,
                        status: thisProc.pm2_env.status,
                        uptime: `${Math.ceil((Date.now() - thisProc.pm2_env.pm_uptime) / 1000 / 60 * 100) / 100} minutes`,
                        restarts: thisProc.pm2_env.unstable_restarts,
                        envname: thisProc.pm2_env.npm_config_envname,
                        monit: thisProc.monit
                    }
                });
                console.log(`Process summary (${listSummary.length}):`);
                console.log(listSummary);
                pm2.disconnect();
            });
        });

        if (self.pm2HealthLogInterval) return;
        self.pm2HealthLogInterval = setInterval(() => {
            self.initPm2HealthLogInterval();
        }, self.pm2HealthLogIntervalTime);
    }

    initRotateLogsInterval() {
        const self = this;
        // PM2 logs all processes to a log file starting with day tstamp "00000" e.g. 00000-wordExtractor-out.log.
        // The 0 day id denotes that this is an actively writing log file. In intervals, we copy the active log to a new file
        // which is prepended with today's real day tstamp, and that file is synced to google drive.
        const notExpiredDayTstamps = self.getDayTstamps(7); // Keep daily log files on local machine for 1 week
        const todayTstamp = notExpiredDayTstamps[0];
        const yestTstamp = notExpiredDayTstamps[1];
        self.getAllLogFileNames((localLogFileNames) => {
            // 1. Check that we have a log file for today (if we haven't yet created one, it's likely a new day just turned). When
            //    we reach this scenario, copy the active log file one last time (to yesterday's tstamp), then clear the active log file
            //    because we will start copying a fresh active log to today's newly created archived log file.
            const alreadyCreatedTodaysLogFile = localLogFileNames.some(thisLogFileName => thisLogFileName.indexOf(todayTstamp) !== -1);
            if (!alreadyCreatedTodaysLogFile) {
                console.log(`Good morning! New log files will be created for today's tStamp: ${todayTstamp}`);
                let pendingFileCopies = 0;
                let finishedFileCopies = 0;
                localLogFileNames.forEach((thisLogFileName) => {
                    if (thisLogFileName.indexOf('00000') === -1) return;
                    const activeLogFilePath = path.resolve(logDir, thisLogFileName);
                    const yestLogFileName = thisLogFileName.replace('00000', yestTstamp);
                    const yestLogFilePath = path.resolve(logDir, yestLogFileName);
                    const newDayLogFileName = thisLogFileName.replace('00000', todayTstamp);
                    const newDayLogFilePath = path.resolve(logDir, newDayLogFileName);;
                    ++pendingFileCopies;
                    fs.copyFile(activeLogFilePath, yestLogFilePath, (err) => {
                        if (err) console.warn(err);
                        // Reset this active log file to empty.
                        fs.truncateSync(path.resolve(logDir, activeLogFilePath));
                        // AND create a new log file with today's tstamp.
                        fs.openSync(newDayLogFilePath, 'w');
                        // If we have created all the necc. log files, let this function run again to finish cleaning up.
                        ++finishedFileCopies;
                        if (finishedFileCopies === pendingFileCopies) {
                            self.initRotateLogsInterval();
                        }
                    });
                });
                return; // Return immediately because below logic can't execute until we have created all necc. log files.
            }
            // 2. Copy all active log file (00000) content into the log file created to archive today's logs
            localLogFileNames.forEach((thisLogFileName) => {
                if (thisLogFileName.indexOf('00000') === -1) return;
                const todayLogFileName = thisLogFileName.replace('00000', todayTstamp);
                fs.copyFile(path.resolve(logDir, thisLogFileName), path.resolve(logDir, todayLogFileName), (err) => {
                    if (err) console.warn(err);
                    // console.log(`Transferred active log data to today's log archive file: ${thisLogFileName} => ${todayLogFileName}`);
                });
            });
            // 3. Now determine if any of the existing local log files should be deleted (expired).
            localLogFileNames.forEach((thisFileName) => {
                let dayTstampForThisFileName = thisFileName.split('-')[tstampPosInFilename];
                if (notExpiredDayTstamps.indexOf(dayTstampForThisFileName) !== -1 || dayTstampForThisFileName === '00000') return;
                const fullLogFilePath = path.resolve(logDir, thisFileName);
                fs.unlink(fullLogFilePath, (err) => {
                    if (err) {
                        console.warn(`Could not delete expired log file: ${fullLogFilePath}`, err);
                        return;
                    }
                    console.log(`Deleted expired log file: ${fullLogFilePath}`);
                });
            });
        }); // end getAllLogFileNames

        if (self.rotateLogsInterval) return;
        self.rotateLogsInterval = setInterval(() => {
            self.initRotateLogsInterval();
        }, self.rotateLogsIntervalTime);
    }

    initRotateRDBInterval() {
        const self = this;
        const notExpiredDayTstamps = self.getDayTstamps(7); // Keep rdb backups on local machine for 1 week
        const todayTstamp = notExpiredDayTstamps[0];
        self.getAllRDBFileNames((localRDBFileNames) => {
            // Determine if this local rdb file should be deleted (expired).
            localRDBFileNames.forEach((thisFileName) => {
                let dayTstampForThisFileName = thisFileName.split('-')[tstampPosInFilename];
                if (notExpiredDayTstamps.indexOf(dayTstampForThisFileName) !== -1 || dayTstampForThisFileName === '00000') return;
                const fullRDBFilePath = path.resolve(rdbDir, thisFileName);
                fs.unlink(fullRDBFilePath, (err) => {
                    if (err) {
                        console.warn(`Could not delete expired rdb file: ${fullRDBFilePath}`, err);
                        return;
                    }
                    console.log(`Deleted expired rdb file: ${fullRDBFilePath}`);
                });
            });
        });

        if (self.rotateRDBInterval) return;
        self.rotateRDBInterval = setInterval(() => {
            self.initRotateRDBInterval();
        }, self.rotateRDBIntervalTime);
    }

    initArchiveLogsInterval() {
        const self = this;
        // This interval uploads the active log file (00000) AND today's log to google drive
        const todayTstamp = self.getDayTstamps(1)[0]; // Just need today's tstamp
        self.getAllLogFileNames((fileNames) => {
            fileNames.forEach((thisFileName) => {
                let dayTstampForThisFileName = thisFileName.split('-')[tstampPosInFilename];
                if (dayTstampForThisFileName !== todayTstamp && dayTstampForThisFileName !== '00000') return; // also upload the active log file at this point
                const fullLogFilePath = path.resolve(logDir, thisFileName);
                self.uploadFileToGdrive(thisFileName, fullLogFilePath, (res) => {
                    if (!res) return;
                    console.log(`Archived log ${thisFileName} to google drive...`);
                });
            });
        });

        if (self.archiveLogsInterval) return;
        self.archiveLogsInterval = setInterval(() => {
            self.initArchiveLogsInterval();
        }, self.archiveLogsIntervalTime);
    }

    initArchiveRDBInterval() {
        const self = this;
        // This interval only uploads the active RDB file (00000) to google drive, but then also copies/renames it in-place on gdrive using today's timstamp
        const todayTstamp = self.getDayTstamps(1)[0]; // Just need today's tstamp
        self.getAllRDBFileNames((localRDBFileNames) => {
            // 1. Copy the active RDB file to one prepended with today's timestamp, then upload the archive copy to google drive.
            localRDBFileNames.forEach((thisFileName) => {
                let dayTstampForThisFileName = thisFileName.split('-')[tstampPosInFilename];
                if (dayTstampForThisFileName !== '00000') return; // Make sure we have the filename for the active rdb
                const activeRDBFileName = thisFileName;
                const activeRDBFilePath = path.resolve(rdbDir, activeRDBFileName);
                const todayRDBBackupFileName = activeRDBFileName.replace('00000', todayTstamp);
                const todayRDBBackupPath = path.resolve(rdbDir, todayRDBBackupFileName);
                fs.copyFile(activeRDBFilePath, todayRDBBackupPath, (err) => {
                    if (err) {
                        console.warn(err);
                        return;
                    }
                    // console.log(`Transferred active rdb file to today's rdb archive file: ${thisFileName} => ${todayRDBBackupFileName}`)
                    const startTime = Date.now();
                    self.uploadFileToGdrive(todayRDBBackupFileName, todayRDBBackupPath, (res) => {
                        if (!res) return;
                        const endTime = Date.now();
                        console.log(`Archived rdb ${todayRDBBackupFileName} to google drive. Upload duration: ${Math.floor((endTime-startTime) / 1000)}s`);
                        // At this point we ALSO COPY THIS SAME FILE but rename with the 00000 tstamp (this is so we can programatically locate the active DB file for this machine)
                        self.copyFileOnGdrive(res.data.id, activeRDBFileName, (success) => {
                            if (success) console.log(`Archived rdb ${activeRDBFileName} to google drive`);
                        });
                    });
                });
            });
        });

        if (self.archiveRDBInterval) return;
        self.archiveRDBInterval = setInterval(() => {
            self.initArchiveRDBInterval();
        }, self.archiveRDBIntervalTime);
    }

    initCloudArchiveCleanupInterval() {
        const self = this;
        const notExpiredDayTstamps = self.getDayTstamps(3); // Keep daily log files and daily RDB backupes in cloud for 3 days
        const oldestNotExpiredTstamp = notExpiredDayTstamps.pop();
        console.log(`Now checking google drive for expired archived log/db files which should be deleted...`)
        self.googleDriveClient.files.list({pageSize: 1000}, (err, res) => {
            if (err) {
                console.warn(err);
                return;
            }
            if (res.data && res.data.files) {
                const listedFiles = [...res.data.files];
                const deleteTheseFiles = [];
                listedFiles.forEach((thisFile) => {
                    let dayTstampForThisFileName = thisFile.name.split('-')[tstampPosInFilename];
                    if (!dayTstampForThisFileName || dayTstampForThisFileName.length !== 5) return; // day tstamps should always be 5 chars long. see getDayTstamps below.
                    if (parseInt(dayTstampForThisFileName) < oldestNotExpiredTstamp && dayTstampForThisFileName !== '00000') {
                        deleteTheseFiles.push(thisFile);
                    }
                });
                if (deleteTheseFiles.length === 0) return;
                const deleteThisFile = (thisFile) => {
                    self.googleDriveClient.files.delete({fileId: thisFile.id}, (delErr, delRes) => {
                        if (err) console.warn(err);
                        console.log(`Cleaned up expired file from google drive: ${thisFile.name}`);
                        ++deleteCount;
                        setTimeout(() => {
                            if (!deleteTheseFiles[deleteCount]) return;
                            deleteThisFile(deleteTheseFiles[deleteCount])
                        }, 1000)
                    });
                };
                let deleteCount = 0;
                deleteThisFile(deleteTheseFiles[deleteCount])
            }
        });

        if (self.cloudArchiveCleanupInterval) return;
        self.cloudArchiveCleanupInterval = setInterval(() => {
            self.initCloudArchiveCleanupInterval();
        }, self.cloudArchiveCleanupIntervalTime);
    }

    getAllLogFileNames(cback) {
        const self = this;
        const allLogFileNames = [];
        fs.readdir(logDir, (err, files) => {
            if (err || !files || files.length === 0) {
                console.log(`Could not find any .log files in log directory: ${logDir}`, err);
                return;
            }
            // Now determine if each file is a log file, and if so, if it should be deleted (expired).
            files.forEach((thisFileName) => {
                if (thisFileName.indexOf('.log') === -1) return;
                let dayTstampForThisFileName = thisFileName.split('-')[tstampPosInFilename];
                if (!dayTstampForThisFileName || dayTstampForThisFileName.length !== 5) return; // day tstamps should always be 5 chars long. see getDayTstamps below.
                dayTstampForThisFileName = parseInt(dayTstampForThisFileName);
                if (typeof dayTstampForThisFileName !== 'number') return;
                allLogFileNames.push(thisFileName);
            });
            if (cback) cback(allLogFileNames);
        });
    }

    getAllRDBFileNames(cback) {
        const self = this;
        const allRDBFileNames = [];
        fs.readdir(rdbDir, (err, files) => {
            if (err || !files || files.length === 0) {
                console.warn(`Could not find any .rdb files in db directory: ${rdbDir}`, err);
                return;
            }
            // Now determine if each file is a rdb file, and if so, if it should be deleted (expired).
            files.forEach((thisFileName) => {
                if (thisFileName.indexOf('.rdb') === -1) return;
                let dayTstampForThisFileName = thisFileName.split('-')[tstampPosInFilename];
                if (!dayTstampForThisFileName || dayTstampForThisFileName.length !== 5) return; // day tstamps should always be 5 chars long. see getDayTstamps below.
                dayTstampForThisFileName = parseInt(dayTstampForThisFileName);
                if (typeof dayTstampForThisFileName !== 'number') return;
                allRDBFileNames.push(thisFileName);
            });
            if (cback) cback(allRDBFileNames);
        });
    }

    uploadFileToGdrive(fileName, filePath, cback, overwrite = true) {
        const self = this;
        if (overwrite) {
            self.deleteFileFromGdrive(fileName, () => {
                self.uploadFileToGdrive(fileName, filePath, cback, false);
            });
            return;
        }
        console.log(`Will now attempt to upload file to google drive... ${fileName}`);
        self.googleDriveClient.files.create({
            requestBody: {
                name: fileName,
                mimeType: 'text/plain',
                parents: ['15THZq0ddZmIpYgeP9-YNIYSKnKonwjuj'], // this is the folder "service-hashHype" which is shared from jwebbphoto gdrive
            },
            media: {
                mimeType: 'text/plain',
                body: fs.createReadStream(filePath)
            }
        }, (err, res) => {
            if (err) console.warn(err);
            if (cback) cback(res);
        });

    }

    deleteFileFromGdrive(fileName, cback) {
        const self = this;
        console.log(`Now attempting to locate and delete file on google drive... ${fileName}`);
        self.googleDriveClient.files.list({
            q: `name = '${fileName}'`
        }, (err, res) => {
            if (err || !res.data || !res.data.files) {
                console.warn(err);
                if (cback) cback();
                return;
            }
            const deleteTheseFiles = res.data.files;
            if (deleteTheseFiles.length === 0) {
                console.log(`Could not locate any google drive file by the following name: ${fileName}`);
                if (cback) cback();
                return;
            }
            let deletedCount = 0;
            deleteTheseFiles.forEach((thisFile, index) => {
                console.log(`Now deleting google drive file ID:${thisFile.id} (${fileName})`);
                self.googleDriveClient.files.delete({fileId: thisFile.id}, (err, res) => {
                    if (err) console.warn(err);
                    // console.log(`Deleted file from google drive: ${thisFile.name}`);
                    ++deletedCount;
                    if (deletedCount === deleteTheseFiles.length) {
                        if (cback) cback();
                    }
                });
            });

        });
    }

    copyFileOnGdrive(copyFileId, destFileName, cback, overwrite = true) {
        const self = this;
        if (overwrite) {
            self.googleDriveClient.files.list({
                q: `name = '${destFileName}'`
            }, (err, res) => {
                if (err || !res.data || !res.data.files || !res.data.files.length) {
                    console.error(`ERR! ${destFileName} does not yet exist or could not be found on gdrive.`, err);
                    self.copyFileOnGdrive(copyFileId, destFileName, cback, false);
                    return;
                }
                self.googleDriveClient.files.delete({fileId: res.data.files[0].id}, (err, res) => {
                    if (err) console.error(err);
                    console.log(`Deleted ${destFileName} before attempting to copy ${copyFileId} to the same name.`);
                    self.copyFileOnGdrive(copyFileId, destFileName, cback, false);
                });
            });
            return;
        }
        self.googleDriveClient.files.copy({
            fileId: copyFileId,
            requestBody: {
                name: destFileName
            }
        }, (err, response) => {
            if (err) {
                console.error(`ERR! Could not copy RDB file on google drive... `, err);
                if (cback) cback(false);
                return;
            }
            console.log(`Copied gdrive file ${copyFileId} -> ${destFileName}`);
            if (cback) cback(true);
        });
    }

    // deleteAllGdriveFiles() {
    //     const self = this;
    //     self.googleDriveClient.files.list({}, (err, res) => {
    //         if (err) {
    //             console.warn(err);
    //             return;
    //         }
    //         if (res.data && res.data.files) {
    //             const deleteTheseFiles = [...res.data.files];
    //             console.log(`${deleteTheseFiles.length} files google in drive...`)
    //             const deleteThisFile = (thisFile) => {
    //                 self.googleDriveClient.files.delete({fileId: thisFile.id}, (delErr, delRes) => {
    //                     if (err) console.warn(err);
    //                     console.log(`Deleted file from google drive: ${thisFile.name}`);
    //                     ++deleteCount;
    //                     setTimeout(() => {
    //                         if (!deleteTheseFiles[deleteCount]) {
    //                             self.deleteAllGdriveFiles();
    //                             return;
    //                         }
    //                         deleteThisFile(deleteTheseFiles[deleteCount])
    //                     }, 1000)
    //                 });
    //             };
    //             let deleteCount = 0;
    //             deleteThisFile(deleteTheseFiles[deleteCount])
    //         }
    //     });
    // }

    getDayTstamps(dayRange = 7) { // dayRange (int) means how many previous days (including today) you want tstamps for.
        // Returns an array of reduced day timestamps (STRINGS). e.g ['18740', '18739', '18738', '18737', '18736', '18735', '18734']
        const allDayTstamps = [];
        const msInDay = 86400000;
        for (let step = 0; step < dayRange; step++) {
            const prevDay = Math.ceil((Date.now()-(msInDay*step)) / msInDay);
            allDayTstamps.push(`${prevDay}`);
        }
        return allDayTstamps;
    }
}

const thisProcess = new MaintainLogsAndBackups();
export default MaintainLogsAndBackups;
