import path from 'path';
import fs from 'fs';
import {google} from 'googleapis';
import yargs from 'yargs';
import SftpClient from 'ssh2-sftp-client';
import googleConfigs from './googleClient-config.js';
import deployCodeSftpConfig from './deployCodeSftp-config.js';

// This util is part of "lastNpmRun" prop in deployCodeSftpConfig. It finds the active (00000) rdb file for the specified envname in google drive archives,
// then dowloads it to the local machine db directory (before the app pm2 start command). The app will load then load the redis data from that external environment.
const argv = yargs(process.argv.slice(2)).argv;

// Ensure all required directorties exist on local machine
const rdbDir = path.resolve(process.cwd(), '../hashHype_persist/db');
fs.mkdirSync(rdbDir, {recursive: true}); // recursive will allow this command to not error if dir already exists

class MigrateRDB {

    constructor() {
        const self = this;

        const start = Date.now();
        self.downloadAndStoreTargetRDB(() => {
            const finish = Date.now();
            console.log(`MigrateRDB completed in ${(finish-start)/1000} seconds.`);
            if (self.sftpClient) self.sftpClient.end();
        });
    }

    downloadAndStoreTargetRDB(cback) {
        const self = this;

        if (!argv.source || argv.source === 'cloud') {
            self.initGoogleDriveClient(() => {
                self.downloadAndStoreTargetRDBFromGDrive(cback);
            })
            return;
        }

        if (argv.source === 'localNet') {
            let deployConfig = deployCodeSftpConfig.targets[argv.from];
            if (!deployConfig) {
                console.error(`ERR! migrateRDB (${argv.source}) requires a valid argv.from argument. Received "${argv.from}". Process will now exit.`);
                process.exit(1);
                return;
            }
            deployConfig = deployConfig();
            self.initSftpClient(deployConfig, () => {
                self.downloadAndStoreTargetRDBFromLocalNetwork(deployConfig, cback);
            });
        }
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
    downloadAndStoreTargetRDBFromGDrive(cback) {
        const self = this;
        const fromRDBFilenames = {
            // short: `${argv.from}-00000-short.rdb`,
            long: `${argv.from}-00000-long.rdb`
        };
        self.googleDriveClient.files.list({
            // q: `name = '${fromRDBFilenames.short}' or name = '${fromRDBFilenames.long}'`
            q: `name = '${fromRDBFilenames.long}'`
        }, (err, res) => {
            if (err || !res.data || !res.data.files || !res.data.files.length || res.data.files.length !== Object.keys(fromRDBFilenames).length) {
                console.error(`ERR! Could not locate all of the requested RDB files on googe drive. Process will now exit.`, err);
                console.error(`Files requested: `, Object.values(fromRDBFilenames));
                console.error(`Files found: `, res.data.files);
                process.exit(1);
                return;
            }
            res.data.files.forEach((thisFile) => {
                const destFileName = thisFile.name.replace(argv.from, argv.to);
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

    initSftpClient(opts, cback) {
        console.log(`Opening SSH connection with ${opts.host}:${opts.port}`);
        this.sftpClient = new SftpClient();
        this.sftpClient.connect(opts).then(() => {
            if (cback) cback();
        }).catch(err => {
            if (err) console.error(err);
        });
    }
    downloadAndStoreTargetRDBFromLocalNetwork(opts, cback) {
        const self = this;

        const srcFileName = `${argv.from}-00000-long.rdb`
        const srcFilePath = path.join(opts.targetDir, 'hashHype_persist/db', srcFileName);

        const destFileName = `${argv.to}-00000-long.rdb`
        const destFilePath = path.resolve(rdbDir, destFileName);

        const onErr = (err) => {
            console.error(`ERR! Could not downloadAndStoreTargetRDBFromLocalNetwork. Process will now exit.`, err);
            process.exit(1);
        }

        const downloadSrdFile = (copiedSrcFilePath) => {
            console.log(`Downloading... ${copiedSrcFilePath} -> ${destFilePath}`);
            const start = Date.now();
            self.sftpClient.fastGet(copiedSrcFilePath, destFilePath).then(() => {
                const finish = Date.now();
                console.log(`Finished downloading ${destFilePath} in ${(finish-start)/1000} seconds.`);
                self.sftpClient.delete(copiedSrcFilePath); // Cleanup our temp copy, but we won't wait for this to finish.
                if (cback) cback();
            }).catch(err => {
                onErr(err);
                return;
            });
        }

        // First copy the srcFilePath because it's owner machine may need to access the original while we are trying to download it.
        self.sftpClient.client.shell(function(err, stream) { // "self.sftpClient.client" is the underlying ssh2 object (https://github.com/mscdex/ssh2)
            if (err) {
                onErr(err)
                return;
            }

            const copiedSrcFilePath = srcFilePath.replace(srcFileName, `rdbMigrate-${argv.to}.temp`);

            stream.on('close', function() {
                // Now we can downoad our copy
                downloadSrdFile(copiedSrcFilePath);
            }).on('data', function(data) {
                console.log(data.toString());
            }).stderr.on('data', function(data) {
                onErr(data)
            });
            stream.end(`cp ${srcFilePath} ${copiedSrcFilePath}\nexit\n`);
        });
    }

}

const migrateRDB = new MigrateRDB();
export default MigrateRDB;
