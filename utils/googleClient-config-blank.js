// This config sets endpoints and creds for the google api (hashHype currently uses google drive to archive DB and log backups)

module.exports = googleClientConfig = {

    serviceScopes: [],
    serviceCreds: {} // copy directly from service creds json file - https://console.cloud.google.com/projectselector2/iam-admin/serviceaccounts?supportedpurview=project

};
