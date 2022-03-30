import path from 'path';
import fs from 'fs';
import {google} from 'googleapis';
const googleConfigs = require('./googleClient-config.js');

// This util is part of "lastNpmRun" prop in deployCodeSftpConfig. It finds the active (00000) rdb file for the specified envname in google drive archives,
// then dowloads it to the local machine db directory (before the app pm2 start command). The app will load then load the redis data from that external environment.

// Ensure all required directorties exist on local machine
const rdbDir = path.resolve(process.cwd(), '../hashHype_persist/db');
fs.mkdirSync(rdbDir, {recursive: true}); // recursive will allow this command to not error if dir already exists

class MigrateRDB {

    constructor() {
        const self = this;
        this.cliArgs = this.extractCliArgs(); // will raise errors and quit if required args are missing.

        this.initGoogleDriveClient(() => {
            self.downloadAndStoreTargetRDB(() => {

            });
        });
    }

    extractCliArgs() {
        const cliArgsDefaults = {
            from: '', // the source system/envname - dev01, prod02, etc. Is required.
            to: '', // the destination system/envname - dev01, prod02, etc. Is required.
        };
        process.argv.forEach((thisArgv) => {
            if (thisArgv.indexOf('--from') !== -1) cliArgsDefaults.from = thisArgv.replace('--from=', '');
            if (thisArgv.indexOf('--to') !== -1) cliArgsDefaults.to = thisArgv.replace('--to=', '');
        });

        // Confirm required args are present
        if (!cliArgsDefaults.from || !cliArgsDefaults.to) {
            console.error(`ERR! The '--from' and '--to' cli args are required when executing migrateRDB. Script will now exit...`);
            process.exit(1);
        }

        return cliArgsDefaults;
    }

    initGoogleDriveClient(cback) {
        const self = this;
        console.log(`Will now auth a new google API client...`);
        const tempCredsFileData = new Uint8Array(Buffer.from(JSON.stringify(googleConfigs.serviceCreds)));
        const tempCredsFilePath = path.resolve(process.cwd(), 'googleApiServiceCreds.json');
        fs.writeFile(tempCredsFilePath, tempCredsFileData, (err) => {
            if (err) console.log(err);
            const googleClientAuth = new google.auth.GoogleAuth({
                keyFile: tempCredsFilePath,
                scopes: googleConfigs.serviceScopes,
            });
            self.googleDriveClient = google.drive({
                version: 'v3',
                auth: googleClientAuth
            });
            if(cback) cback();
        });
    }

    downloadAndStoreTargetRDB(cback) {
        const self = this;
        const fromRDBFilenames = {
            // short: `${self.cliArgs.from}-00000-short.rdb`,
            long: `${self.cliArgs.from}-00000-long.rdb`
        };
        self.googleDriveClient.files.list({
            q: `name = '${fromRDBFilenames.short}' or name = '${fromRDBFilenames.long}'`
        }, (err, res) => {
            if (err || !res.data || !res.data.files || !res.data.files.length || res.data.files.length !== Object.keys(fromRDBFilenames).length) {
                console.error(`ERR! Could not locate all of the requested RDB files on googe drive. Process will now exit.`, err);
                console.error(`Files requested: `, Object.values(fromRDBFilenames));
                console.error(`Files found: `, res.data.files);
                process.exit(1);
                return;
            }
            res.data.files.forEach((thisFile) => {
                const destFileName = thisFile.name.replace(self.cliArgs.from, self.cliArgs.to);
                const destFilePath = path.resolve(rdbDir, destFileName);
                console.log(`Now downloading ${thisFile.name} and saving locally to: ${destFilePath}`);
                console.log('...');
                const destStream = fs.createWriteStream(destFilePath);
                let downloadedBytes = 0;
                self.googleDriveClient.files.get({
                    fileId: thisFile.id,
                    alt: 'media'
                }, {
                    responseType: 'stream'
                }).then(res => {
                    res.data.on('end', () => {
                        console.log(`Download complete: ${thisFile.name} (${Math.round((downloadedBytes/1048576)*10)/10}mb)`);
                        if (cback) cback();
                    }).on('error', err => {
                        console.error(`ERR! Error during download ${thisFile.name}:`, err);
                        if (cback) cback();
                    }).on('data', d => {
                        downloadedBytes += d.length;
                    }).pipe(destStream);
                });
            });
        });
    }

}

const migrateRDB = new MigrateRDB();
export default MigrateRDB;
