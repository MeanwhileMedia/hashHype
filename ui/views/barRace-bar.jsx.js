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
            renderTextOutside: false, // set to true when the bar width is too small to fit the symbolText. Test will then render outside bar (to the right)
            barLabelDefaultFontSize: '3.5rem',
            barLabelMaxFontSize: Infinity, // when barLabelDefaultFontSize is too large to fit text in space, this value will be used (see checkBarElsForTextSpace)
            barLabelMaxWidth: Infinity, // text may render inside, or outside bar (renderTextOutside), but either way, this number represents the maximum space available.
        }

        this.symbolText = '';
        this.barTextElRef = React.createRef();
    }

    render() {
        const self = this;
        if (!this.state.topComment) return null;

        // const thisCommentPoints = this.state.topComment.totalPoints;
        let thisCommentIsActive = false;
        if (self.state.activeTopComment && self.state.activeTopComment.id === this.state.topComment.id) thisCommentIsActive = true;

        self.symbolText = '';
        let hasTopSymbol = null;
        const hasTopSymbolKey = this.state.topComment.topSymbolHigh || this.state.topComment.topSymbolLow || null;
        if (hasTopSymbolKey) {
            hasTopSymbol = this.state.topComment.symbols.find(thisSymbol => {
                return thisSymbol.key === hasTopSymbolKey;
            });
        }
        if (hasTopSymbol) {
            this.state.topComment.renderedSymbol = hasTopSymbol; // save on comment object for easy access later and in other classes
            self.symbolText = hasTopSymbol.symbol;
        }

        if (self.symbolText) {
            if (self.symbolText[0] === '#') self.symbolText = self.symbolText.slice(1);
        }

        const css = styles.generate(self);
        let barStyles = css.topCommentStats_barRace_bar;
        let barLabelStyles = css.topCommentStats_barRace_bar_label;
        if (thisCommentIsActive) {
            barStyles = Object.assign({}, barStyles, css.topCommentStats_barRace_bar__active);
            barLabelStyles = Object.assign({}, barLabelStyles, css.topCommentStats_barRace_bar__active_label);
        }

        return (
            <li className={`topCommentStats_barRace_bar topCommentStats_barRace_bar__${this.state.topComment.rankRender}`} style={barStyles} onClick={(e) => { self.props.focusTopComment(this.state.topComment) } }>
                <h2 className="topCommentStats_barRace_bar_label" style={barLabelStyles}>
                    <div className="topCommentStats_barRace_bar_label_text_wrapper textOverScroller" style={css.topCommentStats_barRace_bar_label_text_wrapper}>
                        <span ref={this.barTextElRef} className="topCommentStats_barRace_bar_label_text" style={css.topCommentStats_barRace_bar_label_text}>{self.symbolText}</span>
                    </div>
                </h2>
            </li>
        );
    }

} // end view

export default Radium(BarRaceBar);
