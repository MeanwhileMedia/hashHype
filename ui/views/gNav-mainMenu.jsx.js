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
            'Stocks',
            'Coins',
            'Social',
            'News'
        ];
        this.gatedTrendCats = [ // these are the categories that user's must sign-in to see
            'Coins',
            'Social',
            'News'
        ];

        this.state = {
            activeTrendCats: [this.allTrendCats[0]],
            blockedTrendCats: [] // trend cat strings are added here when a not-logged-in user clicks on a gated category
        };
    }

    componentDidMount() {
        utils.setMagicScaleElements();
    }

    toggleTrendCat(trendCatName, e) {
        const newActiveTrendCats = [...this.state.activeTrendCats];
        const reqTrendCatIsActive = this.state.activeTrendCats.indexOf(trendCatName);
        if (this.freezTrendToggling) return;
        if (reqTrendCatIsActive !== -1 && newActiveTrendCats.length === 1) return; // at least one category must always be active
        if (reqTrendCatIsActive !== -1) {
            newActiveTrendCats.splice(reqTrendCatIsActive, 1);
        } else {
            newActiveTrendCats.push(trendCatName);
        }
        this.blockGatedTrendCats(trendCatName);
        this.setState({'activeTrendCats': newActiveTrendCats});
    }

    blockGatedTrendCats(trendCatName) {
        const self = this;
        // Check if this cat is being gated for logged in users only
        if (self.gatedTrendCats.indexOf(trendCatName) !== -1) {
            self.setState({'blockedTrendCats': [trendCatName]});
            self.freezTrendToggling = true;
            setTimeout(() => { // automatically turn toggle switch back off
                const newActiveTrendCats = [...self.state.activeTrendCats];
                if (newActiveTrendCats.indexOf(trendCatName) === -1) return;
                newActiveTrendCats.splice(newActiveTrendCats.indexOf(trendCatName), 1);
                self.freezTrendToggling = false;
                self.setState({'activeTrendCats': newActiveTrendCats});
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
        self.allTrendCats.forEach((thisTrendCatName, index) => {
            const isChecked = self.state.activeTrendCats.indexOf(thisTrendCatName) !== -1;
            const onClick = (e) => {
                if (e.target.tagName === 'INPUT') return; // supress click events that bubble of from the input el changing "checked" attr
                self.toggleTrendCat.call(self, thisTrendCatName, e);
            }
            let loginTooltip = null;
            if (this.state.blockedTrendCats.indexOf(thisTrendCatName) !== -1) {
                loginTooltip = (
                    <button onClick={self.props.gNav.showAboutModal.bind(self.props.gNav)}>
                        <Icon iconName="error" />
                        Log in
                    </button>
                );
            }
            trendCatLis.push(
                <li key={`trendCat${index}`} style={css.GNavMainMenu_li} onClick={onClick}>
                    <span className="magicScale" style={css.GNavMainMenu_li_icon}><ToggleSwitch checked={isChecked}/></span>
                    <span style={css.GNavMainMenu_section_title}>{thisTrendCatName}</span>
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
