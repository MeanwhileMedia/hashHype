// This config sets endpoints and creds for the deployCodeSftp script.
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to deployCodeSftp-config.js (which is gitignored)

const deployCodeSftpConfig = {

    targets: {
        dev01: () => {
            return {
                projectName: '', // set equal to this projects containing folder name
                host: '',
                port: 0,
                username: '',
                password: '',
                targetDir: '', // Relative path (to the default ssh landing DIR (users home dir)). this directory will be the parent to our app folder. After deploy, this directory will have a new folder "hashHype". FULL OVERWRITE
                excludeDirs: [], //dir names should be DOUBLE escaped for use in a regex. i.e: ['\\.git', 'node_modules']. Can be dir or file names. The sftp lib we use matches these patterns against 'node_modules' not '/full/path/to/node_modules/'
                firstNpmRun: [], // if array contains strings, the deploy script will automatically attempt to run each of them as "npm run ${lastNpmRun}" as a first step (synchronously) before transfering any code files, or running npm install, or any lastNpmRun scripts
                wipeFirst: true, // if set to true, deployCodeSftp will first delete entire app folder from target (if it already exists)
                andNpmInstall: true, // when true, deployCodeSftp will attempt to run "npm install" after all of the files have been deployed
                lastNpmRun: [], // if array contains strings, the deploy script will automatically attempt to run each of them as "npm run ${lastNpmRun}" as a final step (synchronously)
                watch: false // when true, deployCodeSftp will also watch local files and re-deploy all code to target any time one file changes
            }
        },
        // prod01: () => { etc },
        // etc
    }

}

export default deployCodeSftpConfig;
