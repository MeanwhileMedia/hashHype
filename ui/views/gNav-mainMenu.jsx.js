import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import ToggleSwitch from './hbWidgets/toggleSwitch.jsx.js';
import Icon from './hbWidgets/icon.jsx.js';
import utils from '../helpers/utils.js';
import styles from './styles/gNav-mainMenu.css.js';

class GNavMainMenu extends React.Component {
    constructor(props) {
        super(props);
        this.allTrendCats = [
            {label: 'Stocks', val: 'stock'},
            {label: 'Coins', val: 'coin'},
            {label: 'Social', val: 'social'},
            {label: 'News', val: 'news'},
        ];
        this.gatedTrendCats = [ // these are the categories that user's must sign-in to see (set to match val above)
            // 'coin',
            'social',
            'news'
        ];

        this.state = {
            clickedTrendCats: this.props.activeSymbolTypes || [this.allTrendCats[0].val],
            blockedTrendCats: [] // trend cat strings are added here when a not-logged-in user clicks on a gated category
        };
    }

    componentDidMount() {
        utils.setMagicScaleElements();
    }

    toggleTrendCat(trendCatVal, e) {
        const newActiveSymbolTypes = [...this.state.clickedTrendCats];
        const reqTrendCatIsActive = this.state.clickedTrendCats.indexOf(trendCatVal);
        if (this.freezTrendToggling) return;
        const trendCatIsBlocked = this.blockGatedTrendCats(trendCatVal);

        if (reqTrendCatIsActive !== -1) {
            newActiveSymbolTypes.splice(reqTrendCatIsActive, 1);
            if (!trendCatIsBlocked) this.props.removeActiveSymbolType(trendCatVal);
        } else {
            newActiveSymbolTypes.push(trendCatVal);
            if (!trendCatIsBlocked) this.props.addActiveSymbolType(trendCatVal);
        }

        this.setState({'clickedTrendCats': newActiveSymbolTypes});
    }

    blockGatedTrendCats(trendCatVal) {
        const self = this;
        // Check if this cat is being gated for logged in users only
        if (self.gatedTrendCats.indexOf(trendCatVal) !== -1) {
            self.setState({'blockedTrendCats': [trendCatVal]});
            self.freezTrendToggling = true;
            setTimeout(() => { // automatically turn toggle switch back off
                const newActiveSymbolTypes = [...self.state.clickedTrendCats];
                if (newActiveSymbolTypes.indexOf(trendCatVal) === -1) return;
                newActiveSymbolTypes.splice(newActiveSymbolTypes.indexOf(trendCatVal), 1);
                self.freezTrendToggling = false;
                self.setState({'clickedTrendCats': newActiveSymbolTypes});
                this.props.removeActiveSymbolType(trendCatVal);
            }, 200);
            return true
        }
        self.setState({'blockedTrendCats': []});
        return false;
    }

    render() {
        const self = this;
        const css = styles.generate(this);

        const trendCatLis = [];
        self.allTrendCats.forEach((thisTrendCat, index) => {
            const isChecked = self.state.clickedTrendCats.indexOf(thisTrendCat.val) !== -1;
            const onClick = (e) => {
                self.toggleTrendCat.call(self, thisTrendCat.val, e);
            }
            let loginTooltip = null;
            if (this.state.blockedTrendCats.indexOf(thisTrendCat.val) !== -1) {
                loginTooltip = (
                    <button style={css.GNavMainMenu_li_tooltip} onClick={self.props.gNav.showAboutModal.bind(self.props.gNav)}>
                        <Icon iconName="error" />
                        Log in
                    </button>
                );
            }
            trendCatLis.push(
                <li key={`trendCat${index}`} style={css.GNavMainMenu_li} onClick={onClick}>
                    <span className="magicScale" style={css.GNavMainMenu_li_icon}><ToggleSwitch checked={isChecked}/></span>
                    <span style={css.GNavMainMenu_section_title}>{thisTrendCat.label}</span>
                    {loginTooltip}
                </li>
            );
        });

        return (
            <nav className='GNavMainMenu' style={css.GNavMainMenu}>
                <ul>
                    {trendCatLis}
                </ul>
                <ul style={css.GNavMainMenu_ul__subsection}>
                    <li key='li5' style={css.GNavMainMenu_li} onClick={this.props.gNav.showAboutModal.bind(this.props.gNav)}>
                        <span style={css.GNavMainMenu_subsection_title}>About</span>
                    </li>
                    <li key='li6' style={css.GNavMainMenu_li} onClick={this.props.gNav.showDisclaimerModal.bind(this.props.gNav)}>
                        <span style={css.GNavMainMenu_subsection_title}>Disclaimer</span>
                    </li>
                </ul>
            </nav>
        );
    }

}

export default Radium(GNavMainMenu);
