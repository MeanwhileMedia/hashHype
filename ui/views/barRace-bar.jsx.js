import React from '/node_modules/react';
import Radium from '/node_modules/radium';

import styles from './styles/barRace-bar.css.js';

class BarRaceBar extends React.Component {
    constructor(props) {
        super(props);

        this.state = {
            topComment: props.topComment,
            rankOnePoints: props.rankOnePoints, // the point count for the topComment (bar) which scored the highest and is rank one. May or may not be this bar.
            activeTopComment: props.activeTopComment || null
        }

        this.barColorPallette = ["#f94144","#f3722c","#f8961e","#f9844a","#f9c74f","#90be6d","#43aa8b","#4d908e","#577590","#277da1"]; //https://coolors.co/palettes/trending
    }

    render() {
        const self = this;
        if (!this.state.topComment) return null;

        const css = styles.generate(self);
        const thisCommentPoints = this.state.topComment.totalPoints['1Hr'];
        let thisCommentIsActive = false;
        if (self.state.activeTopComment && self.state.activeTopComment.id === this.state.topComment.id) thisCommentIsActive = true;

        let symbolText = '';
        let hasTopSymbol = null;
        const hasTopSymbolKey = this.state.topComment.topSymbolHigh['1Hr'].key || this.state.topComment.topSymbolLow['1Hr'].key || null;
        if (hasTopSymbolKey) hasTopSymbol = this.state.topComment.symbols.find(thisSymbol => thisSymbol.redisKey === hasTopSymbolKey);
        if (hasTopSymbol) {
            this.state.topComment.renderedSymbol = hasTopSymbol; // save on comment object for easy access later and in other classes
            symbolText = hasTopSymbol.symbol;
        }

        const zBasedRank = this.state.topComment.rank - 1;
        let theseStyles = {
            'top': `${(css.barHeight*zBasedRank)+(css.barSpaceBetween*zBasedRank)}rem`,
            'width': `${(thisCommentPoints/self.state.rankOnePoints)*100}%`,
            'background-color': self.barColorPallette[zBasedRank]
        };
        if (thisCommentIsActive) theseStyles = Object.assign({}, css.topCommentStats_barRace_bar__active, theseStyles);

        return (
            <li className="topCommentStats_barRace_bar" style={Object.assign({}, css.topCommentStats_barRace_bar, theseStyles)} onClick={(e) => { self.props.focusTopComment(this.state.topComment) } }>
                <h2 className="topCommentStats_barRace_bar_label" style={css.topCommentStats_barRace_bar_label}>{symbolText}</h2>
            </li>
        );
    }

} // end view

export default Radium(BarRaceBar);
