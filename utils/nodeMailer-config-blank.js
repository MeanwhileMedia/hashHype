// This config sets creds for sending emails from node server.
// IMPORTANT: do not change this file. It is only a template. First copy it and rename to nodeMailer-config.js (which is gitignored)

const nodeMailerConfig = {

    accountName1: () => {
        return {
            host: '',
            port: 0,
            secure: false,
            auth: {
                user: '',
                pass: '',
            },
        }
    }

}

export default nodeMailerConfig;
