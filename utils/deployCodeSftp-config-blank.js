// This config sets endpoints and creds for the deployCodeSftp script.
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to deployCodeSftp-config.js (which is gitignored)

const deployCodeSftpConfig = {

    targets: {
        dev01: () => {
            return {
                projectName: '', // set equal to this projects containt folder name
                host: '',
                port: 0,
                username: '',
                password: '',
                targetDir: '', // Relative path (to the default ssh landing DIR (users home dir)). this directory will be the parent to our app folder. After deploy, this directory will have a new folder "hashHype". FULL OVERWRITE
                excludeDirs: [], //dir names should be DOUBLE escaped for use in a regex. i.e: ['\\.git', 'node_modules']
                wipeFirst: true // if set to true, deployCodeSftp will first delete entire app folder from target (if it already exists)
            }
        },
        // prod01: () => { etc },
        // etc
    }

}

export default deployCodeSftpConfig;
