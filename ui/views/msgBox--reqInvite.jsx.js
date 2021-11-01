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

    clickedRequestInvite(e) {
        if (!e.target || !e.target.closest('.inviteForm') || !e.target.closest('.inviteForm').querySelector('.hbWidgets.textInput')) return;
        const requestUserEmailAddy = e.target.closest('.inviteForm').querySelector('.hbWidgets.textInput').innerText;
        if (!requestUserEmailAddy) return;
        this.setState({didRequestInvite: true});

        hbClient.socket.send({
            channel: 'clientReqSendEmail',
            data: {
                emailType: 'inviteRequest',
                requestUserEmailAddy: requestUserEmailAddy
            },
        });
    }

    render() {
        const self = this;
        let inviteForm = (
            <div className="inviteForm" style={{position: 'relative', marginTop: '2rem'}}>
                <button style={{position: 'absolute', top: '-0.4rem', right: 0}} className="button__sev1" onClick={(e) => self.clickedRequestInvite.call(self, e)}>Request</button>
                <TextInput placeholder="you@email.com" textAlign="left" minWidth="100%" />
            </div>
        );
        if (this.state.didRequestInvite) {
            inviteForm = (
                <div className="inviteForm" style={{position: 'relative', marginTop: '2rem'}}>
                    <Icon iconName="check_circle_outline" width="2rem" /><span style={{marginLeft: '0.5rem'}}>Thank you for your interest.</span>
                </div>
            );
        }

        return (
            <MsgBox getAttn={this.props.getAttn} title='Request Invite' subtitle={this.props.subtitle} body={inviteForm} />
        );
    }

}

export default Radium(MsgBox__reqInvite);
