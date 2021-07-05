import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import ToggleSwitch from './hbWidgets/toggleSwitch.jsx';
import menuText from './styles/gNav-mainMenu-text.js';
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

        this.state = {
            activeTrendCats: [this.allTrendCats[0]],
        };
    }

    toggleTrendCat(trendCatName, e) {
        const newActiveTrendCats = [...this.state.activeTrendCats];
        const reqTrendCatIsActive = this.state.activeTrendCats.indexOf(trendCatName);
        if (reqTrendCatIsActive !== -1) {
            newActiveTrendCats.splice(reqTrendCatIsActive, 1);
        } else {
            newActiveTrendCats.push(trendCatName);
        }
        this.setState({'activeTrendCats': newActiveTrendCats});
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
            trendCatLis.push(
                <li key={`trendCat${index}`} style={css.GNavMainMenu_li} onClick={onClick}>
                    <span style={css.GNavMainMenu_li_icon}><ToggleSwitch checked={isChecked}/></span>
                    {thisTrendCatName}
                </li>
            );
        });

        return (
            <nav className='GNavMainMenu' style={css.GNavMainMenu}>
                <ul>
                    {trendCatLis}
                </ul>
                <ul style={css.GNavMainMenu_ul__subsection}>
                    <li key='li5' style={css.GNavMainMenu_li} onClick={this.showAboutModal.bind(this)}>About</li>
                    <li key='li6' style={css.GNavMainMenu_li} onClick={this.showDisclaimerModal.bind(this)}>Disclaimer</li>
                </ul>
            </nav>
        );
    }

    showAboutModal() {
        const css = styles.generate(this);
        const aboutBodyJsx = (
            <div>
                <p style={css.GNavMainMenu_about_body}>{menuText.aboutBody}</p>
                <p style={css.GNavMainMenu_about_tech}>{menuText.aboutTech}</p>
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

}

export default Radium(GNavMainMenu);
