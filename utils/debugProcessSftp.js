import path from 'path';
import fs from 'fs';
import {spawn} from 'child_process';
import yargs from 'yargs';
import SftpClient from 'ssh2-sftp-client';
import deployCodeSftpConfig from './deployCodeSftp-config.js';

const argv = yargs(process.argv.slice(2)).argv;

// This util is part of package.json scripts to deploy code to a target dev or prod machine. It uses sftp to
// push new files to a configured IP address. See deployCodeSftp-config-blank.js for more info.
class DebugProcessSftp {

    constructor() {
        const self = this;
        // this.extractCliArgs();

        this.deployConfig = deployCodeSftpConfig.targets[argv.target]();
        this.initSftpClient(this.deployConfig, () => {
            self.npmRunScriptOnTarget(`debugLocal --procname=${argv.procname}`, () => {
                self.openDebuggerPipe();
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

    openDebuggerPipe() {
        const self = this;
        const sshCmd = spawn('ssh',
            ['-L', '9221:localhost:9229', '-p', self.deployConfig.port, `${self.deployConfig.username}@${self.deployConfig.host}`],
            { stdio: [process.stdin, process.stdout, process.stderr] }
        );
    }

}

const debugProcessSftp = new DebugProcessSftp();
export default DebugProcessSftp;
