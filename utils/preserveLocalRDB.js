import path from 'path';
import fs from 'fs';

// This util is part of "firstNpmRun" prop in deployCodeSftpConfig. It finds the local utils/db/.rdb files and moves them out of the
// app directory (one level up) so that our deploy script can wipe the app directory and reinstall without nuking the local database.
// It is also then included in "lastNpmRun" to transfer those preserved rdb files back into the freshly installed app folder.

class PreserveLocalRDB {

    constructor() {
        const self = this;
        this.cliArgs = this.extractCliArgs(); // will raise errors and quit if required args are missing.

        this.ensureDirectories();
        this.moveLocalRDBFiles(() => {
            if (self.cliArgs.action === 'restore') {
                console.warn(`Local RDB files have been restored and peserveLocalRDB is about to delete temporary rdb backup files at directory: ${self.localRdbBackupDir}`);
                fs.rm(self.localRdbBackupDir, {recursive: true}, (err) => {
                    if (err) console.error(err);
                });
            }
        });
    }

    ensureDirectories() {
        // Ensure all required directorties exist on local machine
        this.localRdbDir = path.resolve(process.cwd(), './utils/db');
        if (this.cliArgs.action === 'backup' && !fs.existsSync(this.localRdbDir)) {
            console.error(`ERR! Cannot locate the local utils/db directory. The preserveLocalRDB process will now exit.`);
            process.exit(1);
            return;
        }
        if (this.cliArgs.action === 'restore') {
            fs.mkdirSync(this.localRdbDir, {recursive: true}); // recursive will allow this command to not error if dir already exists
        }

        this.localRdbBackupDir = path.resolve(process.cwd(), '../hashHype-bak/utils/db');
        fs.mkdirSync(this.localRdbBackupDir, {recursive: true}); // recursive will allow this command to not error if dir already exists
    }

    extractCliArgs() {
        const cliArgsDefaults = {
            action: '', // 'backup' or 'restore' - is required. Tells this script whether it is moving the rdb files out of the app folder, or back in.
        };
        process.argv.forEach((thisArgv) => {
            if (thisArgv.indexOf('--action') !== -1) cliArgsDefaults.action = thisArgv.replace('--action=', '');
        });

        // Confirm required args are present
        if (!cliArgsDefaults.action || (cliArgsDefaults.action !== 'backup' && cliArgsDefaults.action !== 'restore')) {
            console.error(`ERR! The '--action' cli arg is required when executing PreserveLocalRDB. Can be 'backup' or 'restore'. Script will now exit...`);
            process.exit(1);
            return;
        }

        return cliArgsDefaults;
    }

    moveLocalRDBFiles(cback) {
        const self = this;
        let rdbFilePaths = [];
        let srcDir;
        let destDir;

        if (this.cliArgs.action === 'backup') {
            srcDir = this.localRdbDir;
            destDir = this.localRdbBackupDir;
        }
        if (this.cliArgs.action === 'restore') {
            srcDir = this.localRdbBackupDir;
            destDir = this.localRdbDir;
        }
        self.getAllRDBFileNames(srcDir, (allLocalRdbFilenames) => {
            allLocalRdbFilenames.forEach((thisFileName) => {
                rdbFilePaths.push({
                    src: path.resolve(srcDir, thisFileName),
                    dest: path.resolve(destDir, thisFileName),
                });
            });

            let transfersComplete = 0;
            rdbFilePaths.forEach((thisFileSrcDest) => {
                fs.copyFile(thisFileSrcDest.src, thisFileSrcDest.dest, (err) => {
                    if (err) {
                        console.error(`ERR! Failed to preserveLocalRDB. Script will now exit.`, thisFileSrcDest, err);
                        process.exit(1);
                        return;
                    }
                    ++transfersComplete;
                    if (transfersComplete === rdbFilePaths.length) {
                        console.log(`Successful ${this.cliArgs.action} of the following RDB files:`, rdbFilePaths);
                        if (cback) cback();
                    }
                });
            });
        }); // end self.getAllRDBFileNames

    } // end moveLocalRDBFiles

    getAllRDBFileNames(inDir, cback) {
        const self = this;
        const allRDBFileNames = [];
        fs.readdir(inDir, (err, files) => {
            if (err || !files || files.length === 0) {
                console.error(`ERR! Could not find any .rdb files in db directory: ${inDir}`, err);
                return;
            }
            // Now determine which files are .rdb
            files.forEach((thisFileName) => {
                if (thisFileName.indexOf('.rdb') !== -1) allRDBFileNames.push(thisFileName);
            });
            if (cback) cback(allRDBFileNames);
        });
    }

}

const preserveLocalRDB = new PreserveLocalRDB();
export default PreserveLocalRDB;
