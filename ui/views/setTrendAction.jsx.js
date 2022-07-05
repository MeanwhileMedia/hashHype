import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import TextInput from './hbWidgets/textInput.jsx.js'
import RadioSwitch from './hbWidgets/radioSwitch.jsx.js'
import MsgBox__reqInvite from './msgBox--reqInvite.jsx.js'

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

        let renderSymbolText = '';
        if (this.props.activeTopComment && this.props.activeTopComment.renderedSymbol && this.props.activeTopComment.renderedSymbol.symbol) {
            renderSymbolText = this.props.activeTopComment.renderedSymbol.symbol;
        }
        const robinhoodForm = (
            <div key="robinhoodActionForm" style={css.setTrendAction_thirdAppsActionForm}>
                <span className="noBreakTextGroup noBreakTextGroup__bottomMargin">
                    <RadioSwitch options={radioOptions}/>
                </span>
                <span className="noBreakTextGroup noBreakTextGroup__bottomMargin">
                    <TextInput placeholder="1" size="small" minWidth="1rem"/>
                    <span>shares of</span>
                    <TextInput placeholder={renderSymbolText} size="small" minWidth="3rem"/>
                    <span>for</span>
                    <TextInput placeholder="Price (USD)" size="small" minWidth="6rem"/>
                    <span>each.</span>
                </span>
                <button className="button__sev1 button__blockOnMobile" style={css.setTrendAction_thirdAppsActionForm_save} onClick={this.clickedSaveAppAction.bind(this, 'Robinhood')}>Save</button>
            </div>
        );
        return robinhoodForm;
    }

    renderCoinbaseActionForm(css) {
        const radioOptions = [
            {label: 'Buy'},
            {label: 'Sell'}
        ];
        let renderSymbolText = '';
        if (this.props.activeTopComment && this.props.activeTopComment.renderedSymbol && this.props.activeTopComment.renderedSymbol.symbol) {
            renderSymbolText = this.props.activeTopComment.renderedSymbol.symbol;
        }
        const coinbaseForm = (
            <div key="coinbaseActionForm" style={css.setTrendAction_thirdAppsActionForm}>
                <span className="noBreakTextGroup noBreakTextGroup__bottomMargin">
                    <RadioSwitch options={radioOptions}/>
                </span>
                <span className="noBreakTextGroup noBreakTextGroup__bottomMargin">
                    <TextInput placeholder="1" size="small" minWidth="1rem"/>
                    <span>coins of</span>
                    <TextInput placeholder={renderSymbolText} size="small" minWidth="3rem"/>
                    <span>for</span>
                    <TextInput placeholder="Price (USD)" size="small" minWidth="6rem"/>
                    <span>each.</span>
                </span>
                <button className="button__sev1 button__blockOnMobile" style={css.setTrendAction_thirdAppsActionForm_save} onClick={this.clickedSaveAppAction.bind(this, 'Coinbase')}>Save</button>
            </div>
        );
        return coinbaseForm;
    }

    renderTwitterActionForm(css) {
        let renderSymbolText = 'this';
        if (this.props.activeTopComment && this.props.activeTopComment.renderedSymbol && this.props.activeTopComment.renderedSymbol.symbol) {
            renderSymbolText = this.props.activeTopComment.renderedSymbol.symbol;
        }
        const twitterForm = (
            <div key="twitterActionForm" style={css.setTrendAction_thirdAppsActionForm}>
                <TextInput placeholder={`Look at ${renderSymbolText}. #trending @hash_hype`} size="large" ctaGutter="3rem" textAlign="left" />
                <div style={css.setTrendAction_thirdAppsActionForm_ctaSection}>
                    <button style={css.setTrendAction_thirdAppsActionForm_save} className="button__sev1" onClick={this.clickedSaveAppAction.bind(this, 'Twitter')}>Save</button>
                </div>
            </div>
        );
        return twitterForm;
    }

    renderEmailActionForm(css) {
        let renderSymbolText = 'this';
        if (this.props.activeTopComment && this.props.activeTopComment.renderedSymbol && this.props.activeTopComment.renderedSymbol.symbol) {
            renderSymbolText = this.props.activeTopComment.renderedSymbol.symbol;
        }
        const emailForm = (
            <div key="emailActionForm" style={css.setTrendAction_thirdAppsActionForm}>
                <div style={{'padding-bottom': '1rem'}}>
                    <span>Send email to:</span>
                    <TextInput placeholder="person@email.com" size="small" minWidth="3rem"/>
                </div>
                <TextInput placeholder={`Look at ${renderSymbolText}. Trending on HashHype.com`} size="large" ctaGutter="3rem" textAlign="left" />
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

        let renderSymbolText = '';
        if (this.props.activeTopComment && this.props.activeTopComment.renderedSymbol && this.props.activeTopComment.renderedSymbol.symbol) {
            renderSymbolText = this.props.activeTopComment.renderedSymbol.symbol;
        }

        const directionalInputKeySetMap = { // the 'up' and 'down' input
            38: (e) => { return 'up' }, //arrow up
            40: (e) => { return 'down' }, //arrow down
            85: (e) => { return 'up' }, //'u'
            68: (e) => { return 'down' } //'d'
        };

        return (
            <div className="setTrendAction" style={css.setTrendAction}>
                <div style={css.setTrendAction_section}>
                    <h2>
                        <span className="noBreakTextGroup">The next time</span>
                        <div><TextInput placeholder={renderSymbolText} minWidth="6rem" /></div>
                        <span className="noBreakTextGroup">trends <TextInput placeholder="up" type="keySet" keySetMap={directionalInputKeySetMap} minWidth="3rem" /> to <TextInput placeholder={this.props.activeTopComment.rankRender} type="ordinal" minWidth="4rem" /> place:</span>
                    </h2>
                </div>
                <div style={css.setTrendAction_section}>
                    <div style={css.setTrendAction_thirdApps}>
                        <ul onClick={(e) => self.setActiveThirdApp.call(self, e)} style={css.setTrendAction_thirdApps_icons}>
                            <li style={Object.assign({}, css.setTrendAction_thirdApps_icon, css.setTrendAction_thirdApps_icon__Robinhood)}>
                                <img key='app1' style={Object.assign({}, css.setTrendAction_thirdApps_icon_img, css.setTrendAction_thirdApps_icon_img__Robinhood)} src="/ui/images/robinhood.png" alt="Robinhood"/>
                                <h6 style={Object.assign({}, css.setTrendAction_thirdApps_icon_label, css.setTrendAction_thirdApps_icon_label__Robinhood)}>Robinhood</h6>
                            </li>
                            <li style={Object.assign({}, css.setTrendAction_thirdApps_icon, css.setTrendAction_thirdApps_icon__Coinbase)}>
                                <img key='app2' style={Object.assign({}, css.setTrendAction_thirdApps_icon_img, css.setTrendAction_thirdApps_icon_img__Coinbase)} src="/ui/images/coinbase.png" alt="Coinbase"/>
                                <h6 style={Object.assign({}, css.setTrendAction_thirdApps_icon_label, css.setTrendAction_thirdApps_icon_label__Coinbase)}>Coinbase</h6>
                            </li>
                            <li style={Object.assign({}, css.setTrendAction_thirdApps_icon, css.setTrendAction_thirdApps_icon__Twitter)}>
                                <img key='app3' style={Object.assign({}, css.setTrendAction_thirdApps_icon_img, css.setTrendAction_thirdApps_icon_img__Twitter)} src="/ui/images/twitter.png" alt="Twitter"/>
                                <h6 style={Object.assign({}, css.setTrendAction_thirdApps_icon_label, css.setTrendAction_thirdApps_icon_label__Twitter)}>Twitter</h6>
                            </li>
                            <li style={Object.assign({}, css.setTrendAction_thirdApps_icon, css.setTrendAction_thirdApps_icon__Email)}>
                                <img key='app4' style={Object.assign({}, css.setTrendAction_thirdApps_icon_img, css.setTrendAction_thirdApps_icon_img__Email)} src="/ui/images/email.png" alt="Email"/>
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
