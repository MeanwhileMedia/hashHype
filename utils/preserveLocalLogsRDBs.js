import path from 'path';
import fs from 'fs';
import yargs from 'yargs';
const argv = yargs(process.argv.slice(2)).argv;

// This util is part of "firstNpmRun" prop in deployCodeSftpConfig. It finds the local utils/db/.rdb files and moves them out of the
// app directory (one level up) so that our deploy script can wipe the app directory and reinstall without nuking the local database.
// It is also then included in "lastNpmRun" to transfer those preserved rdb files back into the freshly installed app folder.

class PreserveLocalLogsRDBs {

    constructor() {
        const self = this;
        this.localDirs = {
            rdb: path.resolve(process.cwd(), './utils/db'),
            log: path.resolve(process.cwd(), './utils/logs')
        };
        this.localBackupDirs = {
            rdb: path.resolve(process.cwd(), '../hashHype-bak/utils/db'),
            log: path.resolve(process.cwd(), '../hashHype-bak/utils/log')
        };

        if (!argv.preserve_rdbs && !argv.preserve_logs) {
            console.error(`ERR! One of cli args 'preserve_rdbs' or 'preserve_logs' must be passed as true. The preserveLocalLogsRDBs process will now exit.`);
            process.exit(1);
            return;
        }

        const preseveFileTypes = [];
        if (argv.preserve_rdbs) preseveFileTypes.push('rdb');
        if (argv.preserve_logs) preseveFileTypes.push('log');

        this.ensureDirectories();
        this.moveLocalFiles(preseveFileTypes, () => {
            if (argv.action === 'restore') {
                console.warn(`Local rdb/log files have been restored and peserveLocalRDB is about to delete temporary backup files at directories: `, this.localBackupDirs);
                fs.rmSync(self.localBackupDirs.rdb, {recursive: true});
                fs.rmSync(self.localBackupDirs.log, {recursive: true});
            }
        });
    }

    ensureDirectories() {
        // Ensure all required directories exist on local machine
        if (argv.action === 'backup') {
            if ((argv.preserve_rdbs && !fs.existsSync(this.localDirs.rdb)) || (argv.preserve_logs && !fs.existsSync(this.localDirs.log))) {
                console.error(`ERR! Cannot locate the local logs or db directory. The preserveLocalLogsRDBs process will now exit.`);
                process.exit(1);
                return;
            }
        }
        if (argv.action === 'restore') {
            fs.mkdirSync(this.localDirs.rdb, {recursive: true}); // recursive will allow this command to not error if dir already exists
            fs.mkdirSync(this.localDirs.log, {recursive: true});
        }

        fs.mkdirSync(this.localBackupDirs.rdb, {recursive: true}); // recursive will allow this command to not error if dir already exists
        fs.mkdirSync(this.localBackupDirs.log, {recursive: true});
    }

    moveLocalFiles(fileTypes, cback) {
        const self = this;
        let localFilePaths = [];
        let srcDir;
        let destDir;

        if (fileTypes.length > 1) {
            let fileTypesPreservedCount = 0;
            fileTypes.forEach((thisFileType) => {
                self.moveLocalFiles([thisFileType], () => {
                    ++fileTypesPreservedCount;
                    if (fileTypesPreservedCount === fileTypes.length && cback) cback();
                });
            });
            return;
        }

        const targetFileType = fileTypes[0];
        if (argv.action === 'backup') {
            srcDir = this.localDirs[targetFileType];
            destDir = this.localBackupDirs[targetFileType];
        }
        if (argv.action === 'restore') {
            srcDir = this.localBackupDirs[targetFileType];
            destDir = this.localDirs[targetFileType];
        }
        self.getAllFileNames(targetFileType, srcDir, (allLocalFilenames) => {
            if (!allLocalFilenames || allLocalFilenames.length === 0) {
                if (argv.action === 'backup') {
                    console.error(`ERR! Could not backup any .${targetFileType} files in directory: ${srcDir}`);
                    console.error(`Deploy script must exit...`)
                    process.exit(1);
                    return;
                }
                if (argv.action === 'restore') {
                    console.warn(`WARN! Could not restore any .${targetFileType} files because backup directory was empty: ${srcDir}`);
                    console.warn(`Deploy script will proceed under the assumption that target machine was empty, or, this was our first deploy to this machine.`);
                    if (cback) cback();
                    return;
                }
            }

            allLocalFilenames.forEach((thisFileName) => {
                localFilePaths.push({
                    src: path.resolve(srcDir, thisFileName),
                    dest: path.resolve(destDir, thisFileName),
                });
            });

            console.log(`preserveLocalLogsRDBs is about to ${argv.action} ${localFilePaths.length} ${targetFileType} files...`);
            let transfersComplete = 0;
            localFilePaths.forEach((thisFileSrcDest) => {
                fs.copyFile(thisFileSrcDest.src, thisFileSrcDest.dest, (err) => {
                    if (err) {
                        console.error(`ERR! Failed to preserveLocalLogsRDBs. Script will now exit.`, thisFileSrcDest, err);
                        process.exit(1);
                        return;
                    }
                    ++transfersComplete;
                    if (transfersComplete === localFilePaths.length) {
                        console.log(`Successful ${argv.action} of the following ${targetFileType} files:`, localFilePaths);
                        if (cback) cback();
                    }
                });
            });
        }); // end self.getAllFileNames

    } // end moveLocalFiles

    getAllFileNames(withExt, inDir, cback) {
        const self = this;
        const allFileNames = [];
        fs.readdir(inDir, (err, files) => {
            if (err) {
                console.error(`ERR! Could not readdir: ${inDir}`, err);
                process.exit(1);
                return;
            }
            // Now determine which files are .rdb
            files.forEach((thisFileName) => {
                if (thisFileName.indexOf(`.${withExt}`) !== -1) allFileNames.push(thisFileName);
            });
            if (cback) cback(allFileNames);
        });
    }

}

const preserveLocalLogsRDBs = new PreserveLocalLogsRDBs();
export default PreserveLocalLogsRDBs;
