// IMPORTANT: do not commit this file!!!

const deployCodeSftpConfig = {

    targets: {

        dev01: () => {
            return {
                projectName: 'hashHype', // set equal to this projects containt folder name
                host: '172.101.44.184',
                port: 8022,
                username: 'rock',
                password: '834510c4-acc5-435f-92f1-8be3e9a57de2',
                targetDir: './jwebb/code', // Relative path (to the default ssh landing DIR (users home dir)). this directory will be the parent to our app folder. After deploy, this directory will have a new folder "hashHype". FULL OVERWRITE
                excludeDirs: ['\\.git', 'node_modules'], //dir names should be DOUBLE escaped for use in a regex
                wipeFirst: true // if set to true, deployCodeSftp will first delete entire app folder from target (if it already exists)
            };
        },
        dev01_fast: () => {
            const thisConfig = deployCodeSftpConfig.targets.dev01();
            thisConfig.wipeFirst = false;
            return thisConfig;
        },

        prod01: () => {
            // TODO
        }
    }

}

export default deployCodeSftpConfig;
