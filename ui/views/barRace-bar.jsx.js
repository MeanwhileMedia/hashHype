import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import utils from '../helpers/utils.js'

import styles from './styles/barRace-bar.css.js';

class BarRaceBar extends React.Component {
    constructor(props) {
        super(props);

        this.state = {
            topComment: props.topComment,
            maxPointsScale: props.maxPointsScale, // the point count for the rendered topComment (bar) which scored the highest. May or may not be this bar.
            activeTopComment: props.activeTopComment || null,
            renderTextOutside: false // set to true when the bar width is too small to fit the symbolText. Test will then render outside bar (to the right)
        }

        this.barColorPallette = ["#f94144","#f3722c","#f8961e","#f9844a","#f9c74f","#90be6d","#43aa8b","#4d908e","#577590","#277da1"]; //https://coolors.co/palettes/trending
        this.symbolText = '';
        this.barTextElRef = React.createRef();
    }

    render() {
        const self = this;
        if (!this.state.topComment) return null;

        const css = styles.generate(self);
        const thisCommentPoints = this.state.topComment.totalPoints['1Hr'];
        let thisCommentIsActive = false;
        if (self.state.activeTopComment && self.state.activeTopComment.id === this.state.topComment.id) thisCommentIsActive = true;

        self.symbolText = '';
        let hasTopSymbol = null;
        const hasTopSymbolKey = this.state.topComment.topSymbolHigh['1Hr'] || this.state.topComment.topSymbolLow['1Hr'] || null;
        if (hasTopSymbolKey) {
            hasTopSymbol = this.state.topComment.symbols.find(thisSymbol => {
                return thisSymbol.key === hasTopSymbolKey;
            });
        }
        if (hasTopSymbol) {
            this.state.topComment.renderedSymbol = hasTopSymbol; // save on comment object for easy access later and in other classes
            self.symbolText = hasTopSymbol.symbol;
        }

        const zBasedRank = this.state.topComment.rankRender - 1;
        let barStyles = Object.assign({}, css.topCommentStats_barRace_bar, {
            'top': `${(css.barHeight*zBasedRank)+(css.barSpaceBetween*zBasedRank)}rem`,
            'width': `${(thisCommentPoints/self.state.maxPointsScale)*100}%`,
            'background-color': self.barColorPallette[zBasedRank]
        });
        let barLabelStyles = css.topCommentStats_barRace_bar_label;
        if (thisCommentIsActive) {
            barStyles = Object.assign({}, barStyles, css.topCommentStats_barRace_bar__active);
            barLabelStyles = Object.assign({}, barLabelStyles, css.topCommentStats_barRace_bar__active_label);
        }

        return (
            <li className={`topCommentStats_barRace_bar topCommentStats_barRace_bar__${this.state.topComment.rankRender}`} style={barStyles} onClick={(e) => { self.props.focusTopComment(this.state.topComment) } }>
                <h2 className="topCommentStats_barRace_bar_label" style={barLabelStyles}>
                    <span ref={this.barTextElRef} className="topCommentStats_barRace_bar_label_text" style={css.topCommentStats_barRace_bar_label_text}>{self.symbolText}</span>
                </h2>
            </li>
        );
    }

} // end view

export default Radium(BarRaceBar);
