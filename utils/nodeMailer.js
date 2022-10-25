import yargs from 'yargs';
import nodemailer from 'nodemailer';
import nodeMailerConfig from './nodeMailer-config.js';

const argv = yargs(process.argv.slice(2)).argv;

class NodeMailer {

    constructor(transporterAccountName = 'joeATmeanwhile') {
        this.emails = {

            inviteRequest: {
                from: 'joe@meanwhilemedia.com',
                to: 'contact@meanwhilemedia.com',
                subject: 'HashHype user has requested an invite - HashHype_sys_msg',
                text: '', // text and html are set dynamically via setEmailBody
                html: '',
                setEmailBody: (data, emailMsgObj) => {
                    data.envname = argv.envname;
                    emailMsgObj.text = JSON.stringify(data);
                    emailMsgObj.html = emailMsgObj.text;
                    return emailMsgObj;
                }
            },

            maintenaceStatus: {
                from: 'joe@meanwhilemedia.com',
                to: 'contact@meanwhilemedia.com',
                subject: `HashHype daily app status report (${argv.envname}) - HashHype_sys_msg`,
                text: '',
                html: '',
                setEmailBody: (data, emailMsgObj) => {
                    data.envname = argv.envname;
                    emailMsgObj.text = JSON.stringify(data);
                    emailMsgObj.html = emailMsgObj.text;
                    return emailMsgObj;
                }
            },

            diskWarning: {
                from: 'joe@meanwhilemedia.com',
                to: 'contact@meanwhilemedia.com',
                subject: `WARNING! disk space low (${argv.envname}) - HashHype_sys_msg`,
                text: '',
                html: '',
                setEmailBody: (data, emailMsgObj) => {
                    data.envname = argv.envname;
                    data.available = `${data.available/1024}mb`;
                    data.free = `${data.free/1024}mb`;
                    data.total = `${data.total/1024}mb`;
                    emailMsgObj.text = JSON.stringify(data);
                    emailMsgObj.html = emailMsgObj.text;
                    return emailMsgObj;
                }
            }

        }
        const transportConfig = nodeMailerConfig[transporterAccountName]();
        this.transporter = nodemailer.createTransport(transportConfig);
    }

    clientReqSendEmail(message, socket) {
        if (message.data.emailType === 'inviteRequest') {
            const emailMsgObj = this.emails[message.data.emailType];
            emailMsgObj.setEmailBody(message.data, emailMsgObj);
            this.sendEmail(emailMsgObj, message.data.emailType);
            socket.send({
                channel: `status:clientResponse`, // this is just a generic response message that doesn't have any followup logic. Client just logs to console.
                data: 'Invite request succesful.',
            });
        }
    }

    sendEmail(emailMsgObj, emailType, cback){
        this.transporter.sendMail(emailMsgObj, (err, info) => {
            if (err) {
                console.log(`Failed to send ${emailType} email. Err:`, err, emailMsgObj, info);
                if (cback) cback(false);
                return;
            }
            console.log(`${emailType} email sent:`, emailMsgObj, info)
            if (cback) cback(true);
        });
    }

}

export default NodeMailer;
