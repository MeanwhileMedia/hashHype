import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import GNavMainMenu from './gNav-mainMenu.jsx.js';
import SetTrendAction from './setTrendAction.jsx.js';
import MsgBox__reqInvite from './msgBox--reqInvite.jsx.js'
import Icon from './hbWidgets/icon.jsx.js'
import ToggleSwitch from './hbWidgets/toggleSwitch.jsx.js';
import utils from '../helpers/utils.js'

import menuText from './styles/gNav-mainMenu-text.jsx.js';

{/* <hbCC-fEAdmin> */} import AdminTrain from './adminTrain.jsx.js'; {/* </hbCC-fEAdmin> */}

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

    componentDidMount() {
        utils.setMagicScaleElements();
    }

    render() {
        const thisView = this;

        const css = styles.generate(this);
        let gNavStyles = css.GNav;
        const customStyleClasses = this.state.customStyleClasses || [];
        customStyleClasses.forEach((thisClass) => {
            gNavStyles = Object.assign(gNavStyles, css[thisClass]);
        });

        let logoSvg = logo({height: '100%', fill: '#cecece'});
        if (customStyleClasses.indexOf('GNav_theme__light') !== -1) logoSvg = logo({height: '100%', fill: '#888'});

        let closeModalBtn;
        if (this.props.modal.isShown) {
            closeModalBtn = (
                <div style={Object.assign({}, css.GNav_right_ctrls_icon, css.GNav_closeModalBtn)} onClick={this.hideModal.bind(this)}>
                    <Icon iconName="cancel_presentation" width="2.2rem" />
                </div>
            );
        }

        const spinWheelToggleSelected = this.props.topCommentsVizType === 'spinWheel';

        return (
            <div className="GNav" style={gNavStyles}>
                <div className="GNav_left" style={css.GNav_left} onClick={this.showGNavMainMenu.bind(this)}>
                    <span class="GNav_left_logo" style={css.GNav_left_logo} dangerouslySetInnerHTML={{ __html: logoSvg }}></span>
                    <span class="GNav_left_name" style={css.GNav_left_name}>HashHype</span>
                </div>
                <div className="GNav_right" style={css.GNav_right}>
                    <div className="GNav_right_ctrls" style={css.GNav_right_ctrls}>
                        {closeModalBtn}
                        {/* <hbCC-fEAdmin> */}
                        <div style={css.GNav_right_ctrls_icon} onClick={this.showAdminCtrlsModal.bind(this)}>
                            <Icon iconName="settings" width="2.2rem" />
                        </div>
                        {/* </hbCC-fEAdmin> */}
                        <div style={css.GNav_right_ctrls_icon} onClick={this.showSetTrendActionModal.bind(this)}>
                            <Icon iconName="data_saver_on" width="2.2rem" />
                        </div>
                        <div style={css.GNav_right_ctrls_icon} onClick={this.showAboutModal.bind(this)}>
                            <Icon iconName="account_circle" width="2.2rem" />
                        </div>
                        <div style={css.GNav_right_ctrls_icon} onClick={this.showGNavMainMenu.bind(this)}>
                            <Icon iconName="menu" width="2.2rem" />
                        </div>
                    </div>
                </div>
                <div className="GNav_bottom_right" style={css.GNav_bottom_right}>
                    <div className="GNav_bottom_right_ctrls" style={css.GNav_bottom_right_ctrls}>
                        <div style={css.GNav_bottom_right_ctrls_vizCtrl} >
                            <span onClick={ (e) => { if (this.props.topCommentsVizType !== 'barRace') this.props.setTopCommentsVizType('toggle') } } style={Object.assign({}, css.GNav_bottom_right_ctrls_vizCtrl_icon, css.GNav_bottom_right_ctrls_vizCtrl_icon__leaderboard)}>
                                <Icon iconName="leaderboard" width="1.6rem" active={this.props.topCommentsVizType === 'barRace' ? true : false} />
                            </span>
                            <span onClick={ (e) => { if (this.props.topCommentsVizType !== 'spinWheel') this.props.setTopCommentsVizType('toggle') } } style={Object.assign({}, css.GNav_bottom_right_ctrls_vizCtrl_icon)}>
                                <Icon iconName="pie_chart" width="1.6rem" active={this.props.topCommentsVizType === 'spinWheel' ? true : false} />
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    showGNavMainMenu(e, title = '') {
        const mainMenu = (
            <GNavMainMenu
                modal={this.props.modal}
                gNav={this}
                removeActiveSymbolType={this.props.removeActiveSymbolType}
                addActiveSymbolType={this.props.addActiveSymbolType}
                activeSymbolTypes={this.props.activeSymbolTypes}
            />
        );
        this.props.modal.show({
            title: title,
            body: mainMenu,
            customStyleClasses: ['align__left', 'align__top']
        });
    }

    hideModal() {
        this.props.modal.hide();
    }

    showSetTrendActionModal() {
        const setTrendActionUi = (
            <SetTrendAction activeTopComment={this.props.focusedTopComment} hideModal={this.hideModal.bind(this)}/>
        );
        this.props.modal.show({
            // title: 'Set Trend Action',
            // subtitle: 'How would you like to act on this trend in the future?',
            body: setTrendActionUi,
            customStyleClasses: ['align__center']
        });
    }

    showAboutModal() {
        const css = styles.generate(this);

        const aboutBodyJsx = (
            <div>
                <h4 style={css.GNav_section_about_body}>{menuText.aboutBody}</h4>
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
            <AdminTrain topComment={this.props.focusedTopComment} hideModal={this.hideModal.bind(this)}/>
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
