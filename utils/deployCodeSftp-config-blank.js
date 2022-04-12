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
    },

    genKillCommands: (machineConfig) => { // pass this function a pm2 machine config and it will send back an array of batched pm2 stop commands based on the killPriority settings
        const allAppPM2Configs = machineConfig.dbs().concat(machineConfig.apps());
        const machineSingleAppsKillOrder = []; // [[app1, app2, app5], [app3, app4], etc...] - each group will be sent to a single PM2 stop command for an async shutdown.
        allAppPM2Configs.forEach((thisAppPM2Config) => {
            let thisKillPriority = 0;
            if (thisAppPM2Config.killPriority) thisKillPriority = thisAppPM2Config.killPriority;
            machineSingleAppsKillOrder[thisKillPriority] = machineSingleAppsKillOrder[thisKillPriority] || [];
            machineSingleAppsKillOrder[thisKillPriority].push(thisAppPM2Config.name);
        });
        const machineSinglePM2KillCommands = []; // ['pm2 kill app1 app2 app5', 'pm2 kill app3 app4', etc...] - used below in firstNpmRun args
        machineSingleAppsKillOrder.forEach((thisKillBatch, thisKillBatchIndex) => {
            machineSinglePM2KillCommands[thisKillBatchIndex] = `pm2 stop ${thisKillBatch.join(' ')}`;
        });
        return machineSinglePM2KillCommands;
    }
}

export default deployCodeSftpConfig;
