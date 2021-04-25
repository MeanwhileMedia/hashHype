import path from 'path';
import {watch} from 'fs';
import SftpClient from 'ssh2-sftp-client';
import deployCodeSftpConfig from './deployCodeSftp-config.js';

// This util is part of package.json scripts to deploy code to a target dev or prod machine. It uses sftp to
// push new files to a configured IP address. See deployCodeSftp-config-blank.js for more info.
class DeployCodeSftp {

    constructor() {
        const self = this;
        this.localProjectDir = process.cwd();
        this.extractCliArgs();

        this.deployConfig = deployCodeSftpConfig.targets[this.cliArgs.target]();
        this.initSftpClient(this.deployConfig, () => {
            self.deployToTarget(() => {
                if (!this.cliArgs.watch) self.sftpClient.end();
            });
        });

        if (this.cliArgs.watch) {
            this.watchForChangesToDeploy();
        }
    }

    initSftpClient(opts, cback) {
        this.sftpClient = new SftpClient();
        console.log(`Opening SSH connection with ${opts.host}:${opts.port}`);
        this.sftpClient.connect(opts).then(() => {
            if (cback) cback();
        }).catch(err => {
            if (err) console.error(err);
        });
        this.sftpClient.on('upload', info => {
            console.log(`Deployed: ${info.source}`);
        });
    }

    deployToTarget(cback) {
        const self = this;
        const targetDir = `${this.deployConfig.targetDir}/${this.deployConfig.projectName}`;
        this.sftpClient.exists(targetDir).then((exists) => {
            if (exists && self.deployConfig.wipeFirst) {
                console.log(`Now deleting entire app folder (recursive): ${targetDir}`);
                return self.sftpClient.rmdir(targetDir, true);
            }
            return Promise.resolve();
        }).then(() => {
            let exludeRegEx = new RegExp('.*', 'i');
            if (self.deployConfig.excludeDirs && self.deployConfig.excludeDirs.length) {
                let exludeRegexParts = '';
                self.deployConfig.excludeDirs.forEach((thisPart) => {
                    exludeRegexParts = exludeRegexParts + `(?!(${thisPart}))`
                });
                exludeRegEx = new RegExp(`^${exludeRegexParts}.*$`, 'i'); // https://regexr.com/5rd3o
            }
            return self.sftpClient.uploadDir(this.localProjectDir, targetDir, exludeRegEx);
        }).then(() => {
            if (cback) cback();
        }).catch(err => {
            console.error(err);
        });
    }

    watchForChangesToDeploy() {
        const self = this;
        watch(this.localProjectDir, {recursive: true}, (eventType, filename) => {
            self.deployToTarget();
        });
    }

    extractCliArgs() {
        this.cliArgs = {
            target: 'dev01',
            watch: false
        }
        const cliArgs = process.argv.slice(2);

        const indexOfTargetNameCliArg = cliArgs.indexOf('-target');
        if (indexOfTargetNameCliArg !== -1) this.cliArgs.target = cliArgs[indexOfTargetNameCliArg+1] || this.cliArgs.target;

        const indexOfWatchCliArg = cliArgs.indexOf('-watch');
        if (indexOfWatchCliArg !== -1) this.cliArgs.watch = true;
    }

}

const deployCodeSftp = new DeployCodeSftp();
export default DeployCodeSftp;
