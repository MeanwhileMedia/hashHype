import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import TextInput from './hbWidgets/textInput.jsx'
import RadioSwitch from './hbWidgets/radioSwitch.jsx'
import MsgBox__reqInvite from './msgBox--reqInvite.jsx'

import styles from './styles/setTrendAction.css.js';

class SetTrendAction extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            activeThirdApp: 'Robinhood',
            inviteAttn: false, // true when clicking an item that requires login. Will pulse the msgBox (MsgBox__reqInvite)
        }
    }

    componentDidUpdate() {
        this.state.inviteAttn = false;
    }

    setActiveThirdApp(e) {
        let newActiveThirdApp;
        if (!e.target || !e.target.closest('li') || !e.target.closest('li').querySelector('h6') || !e.target.closest('li').querySelector('h6').innerHTML) return;
        newActiveThirdApp = e.target.closest('li').querySelector('h6').innerHTML
        this.setState({activeThirdApp: newActiveThirdApp});
    }

    clickedSaveAppAction(appType) {
        // console.warn(`Login required to save trend actions (${appType}).`);
        this.setState({inviteAttn: true});
    }

    renderAppActionForms() {
        // generates the jsx for each form that renders when a third party app icon is clicked (form renders below)
        const css = styles.generate(this);
        return {
            Robinhood: this.renderRobinhoodActionForm(css),
            Coinbase: this.renderCoinbaseActionForm(css),
            Twitter: this.renderTwitterActionForm(css),
            Email: this.renderEmailActionForm(css),
        };
    }

    renderRobinhoodActionForm(css) {
        const radioOptions = [
            {label: 'Buy'},
            {label: 'Sell'}
        ];
        const robinhoodForm = (
            <div key="robinhoodActionForm" style={css.setTrendAction_thirdAppsActionForm}>
                <RadioSwitch options={radioOptions}/>
                <TextInput placeholder="1" size="small" minWidth="1rem"/>
                <span>shares of</span>
                <TextInput placeholder={this.props.activeTopTag.renderedSymbol.symbol} size="small" minWidth="3rem"/>
                <span>for</span>
                <TextInput placeholder="Price (USD)" size="small" minWidth="6rem"/>
                <span>each.</span>
                <button style={css.setTrendAction_thirdAppsActionForm_save} className="button__sev1" onClick={this.clickedSaveAppAction.bind(this, 'Robinhood')}>Save</button>
            </div>
        );
        return robinhoodForm;
    }

    renderCoinbaseActionForm(css) {
        const radioOptions = [
            {label: 'Buy'},
            {label: 'Sell'}
        ];
        const coinbaseForm = (
            <div key="coinbaseActionForm" style={css.setTrendAction_thirdAppsActionForm}>
                <RadioSwitch options={radioOptions}/>
                <TextInput placeholder="1" size="small" minWidth="1rem"/>
                <span>coins of</span>
                <TextInput placeholder={this.props.activeTopTag.renderedSymbol.symbol} size="small" minWidth="3rem"/>
                <span>for</span>
                <TextInput placeholder="Price (USD)" size="small" minWidth="6rem"/>
                <span>each.</span>
                <button style={css.setTrendAction_thirdAppsActionForm_save} className="button__sev1" onClick={this.clickedSaveAppAction.bind(this, 'Coinbase')}>Save</button>
            </div>
        );
        return coinbaseForm;
    }

    renderTwitterActionForm(css) {
        const twitterForm = (
            <div key="twitterActionForm" style={css.setTrendAction_thirdAppsActionForm}>
                <TextInput placeholder={`Look at ${this.props.activeTopTag.renderedSymbol.symbol}. #trending @hash_hype`} size="large" ctaGutter="3rem"/>
                <div style={css.setTrendAction_thirdAppsActionForm_ctaSection}>
                    <button style={css.setTrendAction_thirdAppsActionForm_save} className="button__sev1" onClick={this.clickedSaveAppAction.bind(this, 'Twitter')}>Save</button>
                </div>
            </div>
        );
        return twitterForm;
    }

    renderEmailActionForm(css) {
        const emailForm = (
            <div key="emailActionForm" style={css.setTrendAction_thirdAppsActionForm}>
                <div style={{'padding-bottom': '1rem'}}>
                    <span>Send email to:</span>
                    <TextInput placeholder="person@email.com" size="small" minWidth="3rem"/>
                </div>
                <TextInput placeholder={`Look at ${this.props.activeTopTag.renderedSymbol.symbol}. It's trending on HashHype.com`} size="large" ctaGutter="3rem"/>
                <div style={css.setTrendAction_thirdAppsActionForm_ctaSection}>
                    <button style={css.setTrendAction_thirdAppsActionForm_save} className="button__sev1" onClick={this.clickedSaveAppAction.bind(this, 'Email')}>Save</button>
                </div>
            </div>
        );
        return emailForm;
    }

    render() {
        const self = this;
        const css = styles.generate(this);

        let activeThirdAppForm = null;
        if (this.state.activeThirdApp) activeThirdAppForm = this.renderAppActionForms()[this.state.activeThirdApp];

        return (
            <div className="setTrendAction" style={css.setTrendAction}>
                <div style={css.setTrendAction_section}>
                    <h4>The next time<TextInput placeholder={this.props.activeTopTag.renderedSymbol.symbol} minWidth="6rem"/>trends to<TextInput placeholder={this.props.activeTopTag.rank} type="ordinal" minWidth="4rem"/>place:</h4>
                </div>
                <div style={css.setTrendAction_section}>
                    <div style={css.setTrendAction_thirdApps}>
                        <ul onClick={(e) => self.setActiveThirdApp.call(self, e)} style={css.setTrendAction_thirdApps_icons}>
                            <li style={Object.assign({}, css.setTrendAction_thirdApps_icon, css.setTrendAction_thirdApps_icon__Robinhood)}>
                                <img key='app1' style={Object.assign({}, css.setTrendAction_thirdApps_icon_img, css.setTrendAction_thirdApps_icon_img__Robinhood)} src="/ui/images/Robinhood.png" alt="Robinhood"/>
                                <h6 style={Object.assign({}, css.setTrendAction_thirdApps_icon_label, css.setTrendAction_thirdApps_icon_label__Robinhood)}>Robinhood</h6>
                            </li>
                            <li style={Object.assign({}, css.setTrendAction_thirdApps_icon, css.setTrendAction_thirdApps_icon__Coinbase)}>
                                <img key='app2' style={Object.assign({}, css.setTrendAction_thirdApps_icon_img, css.setTrendAction_thirdApps_icon_img__Coinbase)} src="/ui/images/Coinbase.png" alt="Coinbase"/>
                                <h6 style={Object.assign({}, css.setTrendAction_thirdApps_icon_label, css.setTrendAction_thirdApps_icon_label__Coinbase)}>Coinbase</h6>
                            </li>
                            <li style={Object.assign({}, css.setTrendAction_thirdApps_icon, css.setTrendAction_thirdApps_icon__Twitter)}>
                                <img key='app3' style={Object.assign({}, css.setTrendAction_thirdApps_icon_img, css.setTrendAction_thirdApps_icon_img__Twitter)} src="/ui/images/Twitter.png" alt="Twitter"/>
                                <h6 style={Object.assign({}, css.setTrendAction_thirdApps_icon_label, css.setTrendAction_thirdApps_icon_label__Twitter)}>Twitter</h6>
                            </li>
                            <li style={Object.assign({}, css.setTrendAction_thirdApps_icon, css.setTrendAction_thirdApps_icon__Email)}>
                                <img key='app4' style={Object.assign({}, css.setTrendAction_thirdApps_icon_img, css.setTrendAction_thirdApps_icon_img__Email)} src="/ui/images/Email.png" alt="Email"/>
                                <h6 style={Object.assign({}, css.setTrendAction_thirdApps_icon_label, css.setTrendAction_thirdApps_icon_label__Email)}>Email</h6>
                            </li>
                        </ul>
                    </div>
                    <div style={css.setTrendAction_thirdAppsActionForm}>
                        {activeThirdAppForm}
                    </div>
                </div>
                <div style={Object.assign({}, css.setTrendAction_section, css.setTrendAction_section__inviteForm)}>
                    <MsgBox__reqInvite getAttn={this.state.inviteAttn} subtitle='Login required. HashHype will be open to new users soon.' />
                </div>
            </div>
        );
    }

}

export default Radium(SetTrendAction);
