import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import {google} from 'googleapis';
import RedisClient from '../utils/redisClient.js';

const logDir = path.resolve(process.cwd(), 'utils/logs');
const rdbDir = path.resolve(process.cwd(), 'utils/db');

const cliArgs = yargs(process.argv).argv;
const gDriveConfigBuffer = new Buffer(cliArgs.gdrive, 'base64');
const gDriveConfigJson = gDriveConfigBuffer.toString('ascii');
const gDriveConfig = JSON.parse(gDriveConfigJson);

// This class performs maintenance tasks related to log rotation, DB snapshot backup to cloud, DB health/status
// monitoring and logging, and is a general catch-all for maintenance tasks.
class MaintainLogsAndBackups {
    constructor() {
        const self = this;
        self.googleDriveClient = null;

        self.dbHealthLogInterval = null;
        self.dbHealthLogIntervalTime = 60000*5; // once per 5 minutes. This is a sizeable log

        self.rotateLogsInterval = null;
        self.rotateLogsIntervalTime = 60000*10; // check every 10mins. Confirm all required local log files exist according to our day tstamp naming pattern. Create a new log file when the day turns. Check logs directory for expired logs to delete from local machine.

        self.archiveLogsInterval = null;
        self.archiveLogsIntervalTime = 60000*30; // backup today's log file to cloud twice/hr

        self.archiveRDBInterval = null;
        self.archiveRDBIntervalTime = 60000*30; // backup all redis rdb files to cloud twice/hr. Uses day tstamp naming pattern.

        self.initRedisClient(() => {
            self.initGoogleDriveClient(() => {
                self.initDbHealthLogInterval();
                self.initRotateLogsInterval();
                self.initArchiveLogsInterval();
                self.initArchiveRDBInterval();
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
        if (self.dbHealthLogInterval) return;
        self.dbHealthLogInterval = setInterval(() => {
            self.redisClient.info('all', function (infoObjArray) {
                // infoObjArray holds "client.server_info" objects for all requested DBs (defaults to run info command on all dbs.)
                if (!infoObjArray || infoObjArray.length === 0) return;
                infoObjArray.forEach((thisDbInfoObj) => {
                    console.log(`DB info stats for "${thisDbInfoObj.dbName}" DB at time ${Date.now()} :`, thisDbInfoObj);
                });
            });
        }, self.dbHealthLogIntervalTime);
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
                let dayTstampForThisFileName = thisFileName.split('-')[0];
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

    initArchiveLogsInterval() {
        const self = this;
        if (self.archiveLogsInterval) return;
        self.archiveLogsInterval = setInterval(() => {
            // This interval only uploads today's log to google drive
            const todayTstamp = self.getDayTstamps(1)[0]; // Just need today's tstamp
            self.getAllLogFileNames((fileNames) => {
                fileNames.forEach((thisFileName) => {
                    let dayTstampForThisFileName = thisFileName.split('-')[0];
                    if (dayTstampForThisFileName !== todayTstamp) return;
                    const fullLogFilePath = path.resolve(logDir, thisFileName);
                    self.uploadFileToGdrive(thisFileName, fullLogFilePath, (res) => {
                        console.log(`Archived log ${thisFileName} to google drive...`);
                    });
                });
            });
        }, self.archiveLogsIntervalTime);
    }

    initArchiveRDBInterval() {
        const self = this;
        if (self.archiveRDBInterval) return;
        self.archiveRDBInterval = setInterval(() => {
            // This interval only uploads today's log to google drive
            const notExpiredDayTstamps = self.getDayTstamps(7); // Keep rdb backups on local machine for 3 weeks
            const todayTstamp = notExpiredDayTstamps[0];
            self.getAllRDBFileNames((localRDBFileNames) => {
                // 1. Copy the active RDB file to one prepended with today's timestamp, then upload the archive copy to google drive.
                localRDBFileNames.forEach((thisFileName) => {
                    let dayTstampForThisFileName = thisFileName.split('-')[0];
                    if (dayTstampForThisFileName !== '00000') return; // Make sure we have the filename for the active rdb
                    const activeRDBFilePath = path.resolve(rdbDir, thisFileName);
                    const todayRDBBackupFileName = thisFileName.replace('00000', todayTstamp);
                    const todayRDBBackupPath = path.resolve(rdbDir, todayRDBBackupFileName);
                    fs.copyFile(activeRDBFilePath, todayRDBBackupPath, (err) => {
                        if (err) {
                            console.warn(err);
                            return;
                        }
                        // console.log(`Transferred active rdb file to today's rdb archive file: ${thisFileName} => ${todayRDBBackupFileName}`)
                        self.uploadFileToGdrive(todayRDBBackupFileName, todayRDBBackupPath, (res) => {
                            console.log(`Archived rdb ${todayRDBBackupFileName} to google drive...`);
                        });
                    });
                });
                // 2. Now determine if this local rdb file should be deleted (expired).
                localRDBFileNames.forEach((thisFileName) => {
                    let dayTstampForThisFileName = thisFileName.split('-')[0];
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
        }, self.archiveRDBIntervalTime);
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
                let dayTstampForThisFileName = thisFileName.split('-')[0];
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
                console.log(`Could not find any .rdb files in db directory: ${logDir}`, err);
                return;
            }
            // Now determine if each file is a log file, and if so, if it should be deleted (expired).
            files.forEach((thisFileName) => {
                if (thisFileName.indexOf('.rdb') === -1) return;
                let dayTstampForThisFileName = thisFileName.split('-')[0];
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
        self.googleDriveClient.files.list({}, (err, res) => {
            if (err) {
                console.warn(err);
                return;
            }
            if (overwrite && res.data && res.data.files) {
                const deleteTheseFiles = res.data.files.filter(thisFile => thisFile.name === fileName);
                let deletedCount = 0;
                deleteTheseFiles.forEach((thisFile, index) => {
                    self.googleDriveClient.files.delete({fileId: thisFile.id}, (err, res) => {
                        if (err) console.warn(err);
                        // console.log(`Deleted file from google drive: ${thisFile.name}`);
                        ++deletedCount;
                        if (deletedCount === deleteTheseFiles.length) {
                            self.uploadFileToGdrive(fileName, filePath, cback, false);
                        }
                    });
                });
                if (deleteTheseFiles.length > 0) return;
            }
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
