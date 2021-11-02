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
            self.npmRunScriptsOnTarget(self.deployConfig.firstNpmRun, () => {
                self.deployToTarget(() => {
                    self.npmInstallOnTarget(() => {
                        self.npmRunScriptsOnTarget(self.deployConfig.lastNpmRun, () => {
                            if (self.deployConfig.watch) {
                                self.watchForChangesToDeploy(self.localProjectDir);
                            } else {
                                self.sftpClient.end();
                            }
                        });
                    });
                });
            });
        });
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
                console.log('...');
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
        if (!self.deployConfig.andNpmInstall) {
            if (cback) cback();
            return;
        }
        const projectDir = `${self.deployConfig.targetDir}/${self.deployConfig.projectName}`;
        self.sftpClient.client.shell(function(err, stream) { // "self.sftpClient.client" is the underlying ssh2 object (https://github.com/mscdex/ssh2)
            if (err) {
                console.error(err);
                return;
            }
            stream.on('close', function() {
                if (cback) cback();
            }).on('data', function(data) {
                if (process.stdout.isTTY) {
                    process.stdout.clearLine();
                    process.stdout.cursorTo(0);
                    process.stdout.write(data.toString());
                } else {
                    console.log(data.toString());
                }
            }).stderr.on('data', function(data) {
                console.log('npmInstallOnTarget STDERR: ' + data);
            });
            stream.end(`cd ${projectDir}\nnpm install\nexit\n`);
        });
    }

    checkTargetAppDirExists(cback) {
        const self = this;
        let doesExist = true;
        const projectDir = `${self.deployConfig.targetDir}/${self.deployConfig.projectName}`;
        self.sftpClient.client.shell(function(err, stream) {
            if (err) {
                console.error(err);
                doesExist = false;
                if (cback) cback(doesExist);
                return;
            }
            stream.on('close', function() {
                if (cback) cback(doesExist);
            }).on('data', function(data) {
                const thisOutput = data.toString();
                console.log(thisOutput);
                if (thisOutput.indexOf('No such file or directory') !== -1) doesExist = false;
            }).stderr.on('data', function(data) {
                console.log('checkTargetAppDirExists STDERR: ' + data);
            });
            console.log(`Checking that app dir ${projectDir} exists on target machine...`)
            stream.end(`cd ${projectDir}\nexit\n`);
        });
    }

    npmRunScriptsOnTarget(runTheseScripts, cback, thisNpmCmdIndex = 0, confirmedAppDirExists = false) {
        const self = this;
        if (!runTheseScripts || !runTheseScripts.length) {
            if (cback) cback();
            return;
        }
        const thisNpmCmd = runTheseScripts[thisNpmCmdIndex]
        if (!thisNpmCmd) {
            if (cback) cback();
            return;
        }

        if (!confirmedAppDirExists) {
            self.checkTargetAppDirExists((doesExist) => {
                if (!doesExist) {
                    console.warn(`WARN! Can't run undefined NPM scripts because the app directory does not yet exist, and there is no package.json. Could not run:`, runTheseScripts);
                    if (cback) cback();
                    return;
                }
                self.npmRunScriptsOnTarget(runTheseScripts, cback, thisNpmCmdIndex, doesExist);
            });
            return;
        }

        self.npmRunScriptOnTarget(thisNpmCmd, (success) => {
            if (!success) {
                console.error(`ERR! deployCodeSftp failed while attempting to run '${thisNpmCmd}'. Deploy failure. Process will now exit.`);
                process.exit(1);
                return;
            }
            self.npmRunScriptsOnTarget(runTheseScripts, cback, ++thisNpmCmdIndex, confirmedAppDirExists);
        });
    }

    npmRunScriptOnTarget(npmScriptCmd, cback) {
        const self = this;
        const projectDir = `${self.deployConfig.targetDir}/${self.deployConfig.projectName}`;
        let scriptSuccess = true;
        self.sftpClient.client.shell(function(err, stream) { // "self.sftpClient.client" is the underlying ssh2 object (https://github.com/mscdex/ssh2)
            if (err) {
                console.error(err);
                return;
            }
            stream.on('close', function() {
                if (cback) cback(scriptSuccess);
            }).on('data', function(data) {
                const thisOutput = data.toString();
                console.log(thisOutput);
                if (thisOutput.indexOf('ERR!') !== -1) scriptSuccess = false;
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
                fs.watchFile(thisFilePath, (eventType, filename) => {
                    self.deployToTarget();
                });
            });
        });
    }

    extractCliArgs() {
        this.cliArgs = {
            target: 'dev01',
        }
        const cliArgs = process.argv.slice(2);

        const indexOfTargetNameCliArg = cliArgs.indexOf('-target');
        if (indexOfTargetNameCliArg !== -1) this.cliArgs.target = cliArgs[indexOfTargetNameCliArg+1] || this.cliArgs.target;
    }

}

const deployCodeSftp = new DeployCodeSftp();
export default DeployCodeSftp;
