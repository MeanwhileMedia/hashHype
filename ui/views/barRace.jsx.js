import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import Icon from './hbWidgets/icon.jsx.js'
import BarRaceBar from './barRace-bar.jsx.js'
import TopCommentBodyAndPoints from './topCommentBodyAndPoints.jsx.js'
import commentFormatter from '../helpers/commentFormatter.js'
import utils from '../helpers/utils.js'

import styles from './styles/barRace.css.js';

class BarRace extends React.Component {
    constructor(props) {
        super(props);

        this.reducedTopComments = []; // the comments after passing through above state filters
        this.maxPointsScale = null; // set to the highest scoring topComment, but only when that topComment points exceeds this.maxPointsScale. This makes for a more stable graph that doesn't rerender the scale of all bars based on the top scoring bar.

        this.barEls = []; // We maintain the same child react components across state changes so that we can animate their style changes (rather than re-instantiation a new child (bar) component during every rerender of this parent)
        this.barElRefs = []; // so this parent can set state to it's children

        this.isFirstLoad = true;

        this.topCommentBodyAndPointsRef = React.createRef(); // so can toggle the points explainer msgBox
    }

    componentDidMount() {
        const self = this;
        this.props.setPageIsReady();
        this.reducedTopComments = this.reduceTopComments();
        this.createBarEls();
        utils.registerWindowResizeEvent('checkBarElsForTextSpace', () => {
            self.checkBarElsForTextSpace.apply(this);
        });
    }

    componentWillUnmount() {
        utils.unregisterWindowResizeEvent('checkBarElsForTextSpace');
    }

    componentDidUpdate(prevProps, prevState) {
        this.reducedTopComments = this.reduceTopComments();
        if (!this.barEls.length) {
            this.createBarEls();
        } else {
            this.updateBarEls();
        }
        this.restoreActiveCommentSelection();
    }

    reduceTopComments() {
        const self = this;

        let reducedTopComments = this.props.topComments;
        if (reducedTopComments.length === 0) { return []; }

        reducedTopComments.sort((a, b) => {
            let sortBy = 'rankAdjust';
            if (a.rankAdjust === b.rankAdjust) sortBy = 'rank';
            return a[sortBy] - b[sortBy];
        });

        // Since we have sorted the bars by rankAdjust, we need to set a UI only prop called "rankRender" which is simply based on the comments index within reducedTopComments
        reducedTopComments.forEach((thisTopComment, thisTopCommentIndex) => {
            thisTopComment.rankRender = thisTopCommentIndex + 1;
        });

        reducedTopComments = reducedTopComments.slice(0, this.props.renderTopCommentCount);

        return reducedTopComments;
    }

    createBarEls() {
        const self = this;
        const barEls = [];
        const barElRefs = [];
        if (!self.reducedTopComments.length) return barEls;

        self.getMaxPointsScale();

        self.reducedTopComments.forEach((thisTopComment) => { // reducedTopComment is already sorted descending
            const thisBarElRef = React.createRef();
            barEls.push(
                <BarRaceBar
                    topComment={thisTopComment}
                    maxPointsScale={self.maxPointsScale}
                    focusTopComment={self.props.focusTopComment}
                    activeTopComment={self.props.focusedTopComment}
                    topCommentsLastUpdated={self.props.topCommentsLastUpdated}
                    ref={thisBarElRef}
                />
            );
            barElRefs.push(thisBarElRef);
        });

        // Since we instantiate and reuse these components for each topCommentStats state change, we need to make sure we have a placeholder bar el even if this initial batch of reducedTopComments is less than 10 (this.props.renderTopCommentCount)
        for (let barCount = barEls.length; barCount < self.props.renderTopCommentCount; ++barCount) {
            const thisBarElRef = React.createRef();
            barEls.push(
                <BarRaceBar
                    topComment={null}
                    maxPointsScale={self.maxPointsScale}
                    focusTopComment={self.props.focusTopComment}
                    activeTopComment={self.props.focusedTopComment}
                    topCommentsLastUpdated={self.props.topCommentsLastUpdated}
                    ref={thisBarElRef}
                />
            );
            barElRefs.push(thisBarElRef);
        }

        this.barEls = barEls;
        this.barElRefs = barElRefs;
    }

    updateBarEls() {
        const self = this;
        const updatedBarEls = [];
        const orphanBarEls = [];
        const orphanTopComments = [];

        self.getMaxPointsScale();

        self.reducedTopComments.forEach((thisTopComment) => { // reducedTopComment is already sorted ascending
            let matchedExistingBarEl = self.barElRefs.find(thisBarRef => {
                if (!thisBarRef.current.state.topComment) return false;
                return thisBarRef.current.state.topComment.id === thisTopComment.id;
            });
            if (matchedExistingBarEl) {
                matchedExistingBarEl.current.setState({
                    topComment: thisTopComment,
                    maxPointsScale: self.maxPointsScale,
                    activeTopComment: self.props.focusedTopComment
                });
                updatedBarEls.push(matchedExistingBarEl);
            } else {
                orphanTopComments.push(thisTopComment);
            }
        });

        self.barElRefs.forEach((thisBarElRef) => {
            if (updatedBarEls.indexOf(thisBarElRef) === -1) {
                thisBarElRef.current.setState({
                    topComment: orphanTopComments.shift(),
                    maxPointsScale: self.maxPointsScale,
                    activeTopComment: self.props.focusedTopComment
                });
                updatedBarEls.push(thisBarElRef);
            }
        });

        setTimeout(() => { // Must let react execute above setStates before attempting to checkBarElsForTextSpace (which makes measurements assuming new props have rendered, then sets state on bar els again).
            self.checkBarElsForTextSpace();
        }, 0);
    }

    checkBarElsForTextSpace() {
        const self = this;
        if (this.props.getTopCommentsVizType() !== 'barRace') return;

        self.sortBarElRefs();
        // This function checks every bar el and determines if the bar isn't wide enough to fit symbol text. If so, text will be place just to the right of the bar.
        let foundShortBar = false; // If a single bar is found to be short, then all lower bars will also put text outside (for uniformity)
        let barLabelMaxFontSize = Infinity; // if a single bar el has symbol text which is too large to fit in AND outside the bar, then ALL bar els scale down their text uniformly so the every symbol text fits.
        self.barElRefs.forEach((thisBarElRef) => { // self.barElRefs are already sorted ascending
            const barState = thisBarElRef.current.state;
            if (!barState.topComment || !barState.topComment.rankRender) return;

            const barsUlEl = document.querySelector('.topCommentStats_barRace_bars');
            const barLabelEl = document.querySelector(`.topCommentStats_barRace_bar__${barState.topComment.rankRender} .topCommentStats_barRace_bar_label`);
            const textWrapperEl = document.querySelector(`.topCommentStats_barRace_bar__${barState.topComment.rankRender} .topCommentStats_barRace_bar_label_text`);
            if (!barsUlEl || !barLabelEl || !textWrapperEl) return;

            const textPadding = utils.curMagicScreenMeasure*2;
            const barsUlElWidth = barsUlEl.getBoundingClientRect().width;
            const barElWidth = (barState.topComment.totalPoints/barState.maxPointsScale) * barsUlElWidth; // px width
            const textWidth = textWrapperEl.getBoundingClientRect().width + textPadding; // px width includes padding

            let thisBarIsTooShort = false;
            const maxWidthForTextInside = barElWidth - textPadding;
            if (textWidth > maxWidthForTextInside) {
                // bar is too small, move text and change color
                thisBarIsTooShort = true;
                foundShortBar = true;
            }

            let thisBarIsTooLong = false;
            const maxWidthForTextOutside = barsUlElWidth - barElWidth - textPadding;
            if (textWidth > maxWidthForTextOutside) {
                // bar is too long for the text to be outside. Text will either be forced inside, or scaled down if it doesn't fit in OR out at current size.
                thisBarIsTooLong = true;
            }


            thisBarElRef.renderTextOutside = false;
            if (thisBarIsTooShort && maxWidthForTextOutside > maxWidthForTextInside) {
                thisBarElRef.renderTextOutside = true; // keep a temporary prop directly on the ref so can be set to state below (after for loop completes)
            }
            if (foundShortBar && !thisBarIsTooLong) {
                thisBarElRef.renderTextOutside = true;
            }

            thisBarElRef.barLabelMaxWidth = maxWidthForTextInside;
            if (thisBarElRef.renderTextOutside) thisBarElRef.barLabelMaxWidth = maxWidthForTextOutside;
            const shrunkFontSize = self.shrinkFontSizeToFillWidth(textWrapperEl, thisBarElRef.barLabelMaxWidth, barState.barLabelDefaultFontSize);
            barLabelMaxFontSize = Math.min(barLabelMaxFontSize, shrunkFontSize);
        });

        self.barElRefs.forEach((thisBarElRef) => {
            thisBarElRef.current.setState({
                renderTextOutside: thisBarElRef.renderTextOutside,
                barLabelMaxWidth: thisBarElRef.barLabelMaxWidth,
                barLabelMaxFontSize: barLabelMaxFontSize,
            });
        });
    }

    shrinkFontSizeToFillWidth(targetEl, targetWidth, startingFontSize, targetElClone) {
        // 1. Clone target el, set innerHtml as text, set startingFontSize, measure width
        // 2. If width is still greater than targetWidth, identify current font size, incrementing down by .1 rem
        // 3. Repeat until the measured width is less than targetWidth
        const minFontSize = utils.curMagicScreenMeasure*2;
        if (!targetElClone) {
            targetElClone = targetEl.cloneNode(true);
            targetEl.after(targetElClone);
            targetElClone.style.opacity = 0;
            targetElClone.style.fontSize = startingFontSize;
        }
        const curStyles = window.getComputedStyle(targetElClone);
        let newFontSize = parseFloat(curStyles.fontSize) - 0.4;
        targetElClone.style.fontSize = `${newFontSize}px`;
        if (targetElClone.getBoundingClientRect().width > targetWidth && newFontSize > minFontSize) {
            return this.shrinkFontSizeToFillWidth(targetEl, targetWidth, startingFontSize, targetElClone);
        } else {
            targetElClone.remove();
            return newFontSize;
        }
    }

    sortBarElRefs() {
        const self = this;
        self.barElRefs.sort((barRefA, barRefB) => {
            let barARank = self.barElRefs.length + 1;
            let barBRank = self.barElRefs.length + 1;
            if (barRefA.current.state.topComment) barARank = barRefA.current.state.topComment.rankRender;
            if (barRefB.current.state.topComment) barBRank = barRefB.current.state.topComment.rankRender;
            return barARank - barBRank;
        });
    }

    getMaxPointsScale() {
        const self = this;
        // This function finds the rendered comment with the highest point count (not necessarily rank 1).
        // This highest count "maxPointsScale" is used to set bar widths.
        let topCommentWithHighestPoints = null;
        self.reducedTopComments.forEach((thisTopComment, thisTopCommentIndex) => {
            if (!topCommentWithHighestPoints || thisTopComment.totalPoints > topCommentWithHighestPoints.totalPoints) topCommentWithHighestPoints = thisTopComment;
        });
        if (!topCommentWithHighestPoints) {
            self.maxPointsScale = 0;
            return;
        }
        const minSpaceUsageForRankOneBar = 0.9; // min percent of parent container the bar must fill. We let it fluctuate within this margin to allow for a more stable chart that isn't constantly scaling based on rank one point changes.
        const newMaxPointsScale = topCommentWithHighestPoints.totalPoints;
        if (self.maxPointsScale && newMaxPointsScale / self.maxPointsScale <= minSpaceUsageForRankOneBar) {
            self.maxPointsScale = newMaxPointsScale;
        } else {
            self.maxPointsScale = Math.max(newMaxPointsScale, self.maxPointsScale);
        }
    }

    restoreActiveCommentSelection() {
        // After all the bar els are updated with fresh topComment data, the activeTopComment may have exited view. In this case, we should reset the activeTopComment
        // to be whichever visible topComment shares the same renderedSymbol (if that visible topComment exists). If none exists, set to default the rank 1 comment active.
        const self = this;
        if (!self.props.focusedTopComment) {
            if (self.reducedTopComments[0]) self.props.focusTopComment(self.reducedTopComments[0]); // prob pageload. set rank 1 active
            return;
        }

        let prevActiveCommentStillExists = false;
        self.reducedTopComments.some((thisTopComment) => {
            if (self.props.focusedTopComment.id === thisTopComment.id) {
                prevActiveCommentStillExists = true;
                return true; // break some loop
            }
        });
        if (prevActiveCommentStillExists) return;

        let foundReplacementActiveTopComment = null;
        self.reducedTopComments.some((thisTopComment) => {
            if (thisTopComment.renderedSymbol && self.props.focusedTopComment.renderedSymbol && thisTopComment.renderedSymbol.symbol === self.props.focusedTopComment.renderedSymbol.symbol) {
                foundReplacementActiveTopComment = thisTopComment;
                return true;
            }
        });
        if (!foundReplacementActiveTopComment) {
            foundReplacementActiveTopComment = self.reducedTopComments[0];
        }
        if (foundReplacementActiveTopComment && foundReplacementActiveTopComment !== self.props.focusedTopComment) {
            self.props.focusTopComment(foundReplacementActiveTopComment);
        }
    }

    createActiveCommentInfoEl() {
        const self = this;
        if (!self.props.focusedTopComment) return null;
        const css = styles.generate(self);

        const topSymbolName = commentFormatter.getRenderableSymbolName(self.props.focusedTopComment);

        return (
            <div className="topCommentStats_barRace_activeComment" style={css.topCommentStats_barRace_activeCommentInfo}>
                <h6><span style={{'opacity': '0.25'}}>Rank:</span> {commentFormatter.getNumberOrdinal(self.props.focusedTopComment.rankRender)}</h6>
                <div className="textOverScroller">
                    <h2 style={css.topCommentStats_barRace_activeCommentInfo_symbolTitle} dangerouslySetInnerHTML={{ __html: topSymbolName }}></h2>
                </div>
                <span style={{'display': 'inline-flex'}}>
                    <span style={css.topCommentStats_barRace_activeCommentInfo_infoBtn} onClick={self.togglePointsInfo.bind(self)}>
                        <Icon iconName="info" height="100%" />
                    </span>
                    <h6 style={{'opacity': '0.25'}}>Top Comment:</h6>
                </span>
                <TopCommentBodyAndPoints
                    ref={this.topCommentBodyAndPointsRef}
                    topComment={self.props.focusedTopComment}
                />
                <div style={css.topCommentStats_barRace_activeCommentInfo_btns}>
                    <span style={css.topCommentStats_barRace_activeCommentInfo_actionBtn}>
                        <button className="button__sev1 button__light" onClick={self.props.gNav.showSetTrendActionModal.bind(self.props.gNav)}>
                            <Icon iconName="data_saver_on" height="100%" />
                            Action
                        </button>
                    </span>
                </div>
            </div>
        )
    }

    togglePointsInfo() {
        this.topCommentBodyAndPointsRef.current.togglePointsInfo();
    }

    render() {
        const self = this;
        const css = styles.generate(self);

        if (this.reducedTopComments.length > 0 && this.reducedTopComments.length < 7 && this.isFirstLoad) {
            this.props.addActiveSymbolType('coin'); // not enough results on page landing, check our next cat.
        }
        if (this.reducedTopComments.length > 0 && this.isFirstLoad) {
            this.isFirstLoad = false;
        }

        const activeCommentInfoEl = self.createActiveCommentInfoEl();
        return (
            <div className="topCommentStats_barRace" style={css.topCommentStats_barRace}>
                <ul className="topCommentStats_barRace_bars" style={css.topCommentStats_barRace_bars}>
                    {this.barEls}
                </ul>
                {activeCommentInfoEl}
            </div>
        );
    }

} // end view

export default Radium(BarRace);
