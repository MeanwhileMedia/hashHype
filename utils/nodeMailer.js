import nodemailer from 'nodemailer';
import nodeMailerConfig from './nodeMailer-config.js';

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
