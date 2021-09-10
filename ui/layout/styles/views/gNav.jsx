import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import GNavMainMenu from './gNav-mainMenu.jsx';
import SetTrendAction from './setTrendAction.jsx';
import MsgBox__reqInvite from './msgBox--reqInvite.jsx'

import menuText from './styles/gNav-mainMenu-text.jsx';

{/* <hbCC-fEAdmin> */} import AdminTrain from './topTagNetworks-adminTrain.jsx'; {/* </hbCC-fEAdmin> */}

import logo from '../images/logo.svg.js';
import styles from './styles/gNav.css.js';

class GNav extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            customStyleClasses: []
        };

        this.props.modal.onHide(() => {
            this.setState({customStyleClasses: []});
        });
        this.props.modal.onShow(() => {
            this.setState({customStyleClasses: ['GNav_theme__light']});
        });
    }

    render() {
        const thisView = this;
        thisView.activeTopTag = this.props.topTags.find(topTag => topTag.isFocused);

        const css = styles.generate(this);
        let gNavStyles = css.GNav;
        const customStyleClasses = this.state.customStyleClasses || [];
        customStyleClasses.forEach((thisClass) => {
            gNavStyles = Object.assign(gNavStyles, css[thisClass]);
        });

        let logoSvg = logo({height: '100%', fill: '#cecece'});
        if (customStyleClasses.indexOf('GNav_theme__light') !== -1) logoSvg = logo({height: '100%', fill: '#888'});

        debugger;
        return (
            <div className="GNav" style={gNavStyles}>
                <div className="GNav_left" style={css.GNav_left} onClick={this.showGNavMainMenu.bind(this)}>
                    <span class="GNav_left_logo" style={css.GNav_left_logo} dangerouslySetInnerHTML={{ __html: logoSvg }}></span>
                    <span class="GNav_left_name" style={css.GNav_left_name}>HashHype</span>
                </div>
                <div className="GNav_right" style={css.GNav_right}>
                    <div className="GNav_right_ctrls" style={css.GNav_right_ctrls}>
                        {/* <hbCC-fEAdmin> */}
                        <div style={css.GNav_right_ctrls_icon} onClick={this.showAdminCtrlsModal.bind(this)}>
                            <span class="material-icons">settings</span>
                        </div>
                        {/* </hbCC-fEAdmin> */}
                        <div style={css.GNav_right_ctrls_icon} onClick={this.showSetTrendActionModal.bind(this)}>
                            <span class="material-icons">data_saver_on</span>
                        </div>
                        <div style={css.GNav_right_ctrls_icon} onClick={this.showAboutModal.bind(this)}>
                            <span class="material-icons">account_circle</span>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    showGNavMainMenu() {
        const mainMenu = (
            <GNavMainMenu modal={this.props.modal} gNav={this}/>
        );
        this.props.modal.show({
            title: '',
            body: mainMenu,
            customStyleClasses: ['align__left', 'align__top']
        });
    }

    hideModal() {
        this.props.modal.hide();
    }

    showSetTrendActionModal() {
        // JWW stopping - show proper details for activeTopTag

        const setTrendActionUi = (
            <SetTrendAction activeTopTag={this.activeTopTag} hideModal={this.hideModal.bind(this)}/>
        );
        this.props.modal.show({
            title: 'Set Trend Action',
            subtitle: 'How would you like to act on this trend in the future?',
            body: setTrendActionUi,
            customStyleClasses: ['align__center']
        });
    }

    showAboutModal() {
        const css = styles.generate(this);

        const aboutBodyJsx = (
            <div>
                <p style={css.GNav_section_about_body}>{menuText.aboutBody}</p>
                <p style={css.GNav_section_about_tech}>{menuText.aboutTech(this)}</p>
                <MsgBox__reqInvite subtitle='HashHype will be open to new users soon.' />
            </div>
        );

        this.props.modal.show({
            title: menuText.aboutHeading,
            body: aboutBodyJsx,
            customStyleClasses: ['align__center']
        });
    }

    showDisclaimerModal() {
        const css = styles.generate(this);
        const aboutBodyJsx = (
            <div style={css.GNavMainMenu_disclaimer}>
                <p>{menuText.disclaimerBody}</p>
            </div>
        );

        this.props.modal.show({
            title: 'Disclaimers',
            body: aboutBodyJsx,
            customStyleClasses: ['align__center', 'align_text__left']
        });
    }

    {/* <hbCC-fEAdmin> */}
    showAdminCtrlsModal() {
        const trainingUi = (
            <AdminTrain topTag={this.activeTopTag} hideModal={this.hideModal.bind(this)}/>
        );
        this.props.modal.show({
            title: 'Relevancy Training',
            body: trainingUi,
            customStyleClasses: ['align__center']
        });
    }
    {/* </hbCC-fEAdmin> */}

} // end gnav class

export default Radium(GNav);
