// This config sets rules for hbCodeChecker (including credentials for priveledged FE code)
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to hbCodeChecker-config.js (which is gitignored)

const hbCodeCheckerConfig = {

    delimeters: { // open and closing delimeters which provide inline classification of code purpose - and potential formatting rules
        fEAdmin: ['{/* <hbCC-fEAdmin> */}', '{/* </hbCC-fEAdmin> */}']
    },

    secrets: {
        fEAdmin: [ // if this secret is sent as part of a request for a UI view file, then all code wrapped in delimeters.fEAdmin will be kept. Otherwise, that code is stripped before sent to client.
            // 'uuid-uuid-uuid-uuid-uuid'
        ]
    },

    secretUserInfo: { // mapped to all uids defined in above secrets object. Can set readable names or other info which can be used for logging or other.
        // 'uuid-uuid-uuid-uuid-uuid': {
        //     name: 'Joe Webb'
        //     ip: '' // regex supported
        // }
    }

}

export default hbCodeCheckerConfig;
