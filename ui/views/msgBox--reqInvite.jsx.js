import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import MsgBox from './msgBox.jsx.js'
import TextInput from './hbWidgets/textInput.jsx.js'
import Icon from './hbWidgets/icon.jsx.js'

class MsgBox__reqInvite extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            didRequestInvite: false, // true if already clicked submit
        }
    }

    clickedRequestInvite(e, inputVal = null) {
        if (!e.target || !e.target.closest('.inviteForm') || !e.target.closest('.inviteForm').querySelector('.hbWidgets.textInput')) return;
        let requestUserEmailAddy = inputVal;
        if (!requestUserEmailAddy) requestUserEmailAddy = e.target.closest('.inviteForm').querySelector('.hbWidgets.textInput').innerText;
        if (!requestUserEmailAddy) return;

        requestUserEmailAddy = requestUserEmailAddy.trim();

        this.setState({didRequestInvite: true});
        localStorage.setItem('hashHype_userRequestInviteEmail', requestUserEmailAddy);

        hbClient.socket.send({
            channel: 'clientReqSendEmail',
            data: {
                emailType: 'inviteRequest',
                requestUserEmailAddy: requestUserEmailAddy
            },
        });
    }

    didUserAlreadyRequestInvite() {
        // also check cookie for return users
        const inviteReqEmail = localStorage.getItem('hashHype_userRequestInviteEmail');
        if (inviteReqEmail) return inviteReqEmail;

        if (this.state.didRequestInvite) return 'you'; // backup for same session (if localStorage didn't work for some reason)
        return false;
    }

    onInputChange(inputVal, e) {
        if (e.nativeEvent.inputType === 'insertParagraph') { // user pressed the enter key
            this.clickedRequestInvite(e, inputVal);
        }
    }

    render() {
        const self = this;

        let subTitle = this.props.subtitle;

        let inviteForm = (
            <div className="inviteForm" style={{position: 'relative', marginTop: '2rem'}}>
                <button style={{position: 'absolute', top: '-0.4rem', right: 0}} className="button__sev1" onClick={(e) => self.clickedRequestInvite.call(self, e)}>Request</button>
                <TextInput placeholder="you@email.com" textAlign="left" minWidth="100%" onInputChange={self.onInputChange.bind(self)} />
            </div>
        );

        const inviteReqEmail = this.didUserAlreadyRequestInvite();
        if (inviteReqEmail !== false) {
            subTitle = '';
            inviteForm = (
                <div className="inviteForm" style={{position: 'relative', marginTop: '0.4rem'}}>
                    <div><Icon iconName="check_circle_outline" width="6rem" fill="#548727" interactive="false" /></div>
                    <p>Your request was received. Thanks for your interest. <br />We will contact <b>{inviteReqEmail}</b> with updates.</p>
                </div>
            )
        }

        return (
            <MsgBox getAttn={this.props.getAttn} title='Request Invite' subtitle={subTitle} body={inviteForm} />
        );
    }

}

export default Radium(MsgBox__reqInvite);
