import path from 'path';
import fs from 'fs';
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
                if (!this.cliArgs.watch) {
                    self.npmInstallOnTarget(() => {
                        self.npmRunScriptsOnTarget(() => {
                            self.sftpClient.end();
                        });
                    });
                }
            });
        });

        if (this.cliArgs.watch) {
            this.watchForChangesToDeploy(this.localProjectDir);
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

    npmInstallOnTarget(cback) {
        const self = this;
        const projectDir = `${self.deployConfig.targetDir}/${self.deployConfig.projectName}`;
        self.sftpClient.client.shell(function(err, stream) { // "self.sftpClient.client" is the underlying ssh2 object (https://github.com/mscdex/ssh2)
            if (err) {
                console.error(err);
                return;
            }
            stream.on('close', function() {
                if (cback) cback();
            }).on('data', function(data) {
                console.log(data.toString());
            }).stderr.on('data', function(data) {
                console.log('npmInstallOnTarget STDERR: ' + data);
            });
            stream.end(`cd ${projectDir}\nnpm install\nexit\n`);
        });
    }

    npmRunScriptsOnTarget(cback, thisNpmCmdIndex = 0) {
        const self = this;
        if (!self.deployConfig.andNpmRun || !self.deployConfig.andNpmRun.length) {
            if (cback) cback();
            return;
        }
        const thisNpmCmd = self.deployConfig.andNpmRun[thisNpmCmdIndex]
        if (!thisNpmCmd) {
            if (cback) cback();
            return;
        }
        self.npmRunScriptOnTarget(thisNpmCmd, () => {
            self.npmRunScriptsOnTarget(cback, ++thisNpmCmdIndex);
        });
    }

    npmRunScriptOnTarget(npmScriptCmd, cback) {
        const self = this;
        const projectDir = `${self.deployConfig.targetDir}/${self.deployConfig.projectName}`;
        self.sftpClient.client.shell(function(err, stream) { // "self.sftpClient.client" is the underlying ssh2 object (https://github.com/mscdex/ssh2)
            if (err) {
                console.error(err);
                return;
            }
            stream.on('close', function() {
                if (cback) cback();
            }).on('data', function(data) {
                console.log(data.toString());
            }).stderr.on('data', function(data) {
                console.log('npmRunScriptOnTarget STDERR: ' + data);
            });
            console.log(`Will now attempt 'npm run ${npmScriptCmd}' on target machine...`)
            stream.end(`cd ${projectDir}\nnpm run ${npmScriptCmd}\nexit\n`);
        });
    }

    watchForChangesToDeploy(watchDirectory) {
        const self = this;
        // watching all files individually (to support linux) - see https://nodejs.org/docs/latest/api/fs.html#fs_caveats
        const ignore = [ // can be files or dirs
            'node_modules',
            '.git'
        ];
        console.log(`Watching for changes to files in dir: ${watchDirectory}`)
        fs.readdir(watchDirectory, {withFileTypes: true}, (err, files) => {
            if (err) console.error(err);
            files.forEach((thisFileDesc) => {
                if (ignore.indexOf(thisFileDesc.name) !== -1) return;
                const thisFilePath = path.resolve(watchDirectory, thisFileDesc.name);
                if (thisFileDesc.isDirectory()) {
                    self.watchForChangesToDeploy(thisFilePath);
                    return;
                }
                fs.watch(thisFilePath, (eventType, filename) => {
                    self.deployToTarget();
                });
            });
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
