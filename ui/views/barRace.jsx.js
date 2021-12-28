import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import Icon from './hbWidgets/icon.jsx.js'
import BarRaceBar from './barRace-bar.jsx.js'
import commentFormatter from '../helpers/commentFormatter.js'
import utils from '../helpers/utils.js'

import styles from './styles/barRace.css.js';

class BarRace extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            topCommentCount: 10, // how many topComments to show in our wheel
            showOnlyTopCommentsWithSymbols: true, // don't display an comments on our wheel unless they are associated with at least one symbol
            showTopCommentSymbolsOnlyOnce: true, // our server will send a max of 2 comments to represent any single symbol. Set this true and we will only render the higher scoring one. Will only apply when showOnlyTopCommentsWithSymbols == true.
            showTopCommentSymbolTypes: ['stock'], // can be set to one or more of strings equaling a symbol.type
            topCommentsLastUpdated: this.props.topCommentsLastUpdated || Date.now()
        };

        this.reducedTopComments = []; // the comments after passing through above state filters
        this.rankOnePoints = null; // set to the highest scoring topComment, but only when that topComment points exceeds this.rankOnePoints. This makes for a more stable graph that doesn't rerender the scale of all bars based on the top scoring bar.

        this.barEls = []; // We maintain the same child react components across state changes so that we can animate their style changes (rather than re-instantiation a new child (bar) component during every rerender of this parent)
        this.barElRefs = []; // so this parent can set state to it's children

        utils.registerWindowResizeEvent('checkBarElsForTextSpace', this.checkBarElsForTextSpace.bind(this));
    }

    componentDidMount() {
        this.props.setPageIsReady();
        this.reducedTopComments = this.reduceTopComments();
        this.createBarEls();
    }

    componentDidUpdate(prevProps, prevState) {
        this.reducedTopComments = this.reduceTopComments();
        if (!this.barEls.length) {
            this.createBarEls();
        } else {
            this.updateBarEls();
        }
        this.restoreActiveCommentSelection();
        if (this.state.topCommentsLastUpdated !== this.props.topCommentsLastUpdated) this.setState({topCommentsLastUpdated: this.props.topCommentsLastUpdated});
    }

    reduceTopComments() {
        const self = this;
        let reducedTopComments = [];
        let allPointCounts = []; // for setting color and width of topCommentWheelParts

        if (this.state.showOnlyTopCommentsWithSymbols) {
            const reducedTopCommentsBySymbol = {}; // {GME: [comment3, comment1], APPL: [comment32], etc..} - used for picking the higher scoring symbol comment when showTopCommentSymbolsOnlyOnce == true
            this.props.topComments.forEach((thisTopComment) => {
                const hasTopSymbolKey = thisTopComment.topSymbolHigh['1Hr'] || thisTopComment.topSymbolLow['1Hr'] || null;
                if (hasTopSymbolKey) {
                    const hasTopSymbol = thisTopComment.symbols.find(thisSymbol => thisSymbol.redisKey === hasTopSymbolKey);
                    if (hasTopSymbol && self.state.showTopCommentSymbolTypes.indexOf(hasTopSymbol.type) !== -1) {
                        reducedTopCommentsBySymbol[hasTopSymbolKey] = reducedTopCommentsBySymbol[hasTopSymbolKey] || [];
                        reducedTopCommentsBySymbol[hasTopSymbolKey].push(thisTopComment);
                    }
                }
            });
            if (this.state.showTopCommentSymbolsOnlyOnce) {
                Object.values(reducedTopCommentsBySymbol).forEach((theseTopComments) => {
                    theseTopComments.sort((a, b) => b.totalPoints['1Hr'] - a.totalPoints['1Hr']);
                    reducedTopComments.push(theseTopComments[0]);
                });
            } else {
                reducedTopComments = Object.values(reducedTopCommentsBySymbol).flat()
            }
        } else {
            reducedTopComments = this.props.topComments;
        }
        if (reducedTopComments.length === 0) { return []; }

        reducedTopComments.sort((a, b) => b.totalPoints['1Hr'] - a.totalPoints['1Hr']);
        reducedTopComments = reducedTopComments.slice(0, this.state.topCommentCount);
        reducedTopComments.forEach( (topComment, index) => {
            topComment.rank = index+1;
            const getUniquePointCount = (lastTriedUniqueCount) => {
                if (allPointCounts.indexOf(lastTriedUniqueCount) !== -1) { // Because we use this array to rank trends, we cannot use tie scores. If a tie is found, increment the dup by 1 until it's no longer a dup.
                    lastTriedUniqueCount++;
                    getUniquePointCount(lastTriedUniqueCount);
                    return;
                }
                allPointCounts.push(lastTriedUniqueCount);
                topComment.totalPoints['1Hr'] = lastTriedUniqueCount;
            };
            getUniquePointCount(topComment.totalPoints['1Hr']);
        });

        return reducedTopComments;
    }

    createBarEls() {
        const self = this;
        const barEls = [];
        const barElRefs = [];
        if (!self.reducedTopComments.length) return barEls;

        self.getRankOnePointScale();

        self.reducedTopComments.forEach((thisTopComment) => { // reducedTopComment is already sorted descending
            const thisBarElRef = React.createRef();
            barEls.push(
                <BarRaceBar
                    topComment={thisTopComment}
                    rankOnePoints={self.rankOnePoints}
                    focusTopComment={self.props.focusTopComment}
                    activeTopComment={self.props.focusedTopComment}
                    ref={thisBarElRef}
                />
            );
            barElRefs.push(thisBarElRef);
        });

        // Since we instantiate and reuse these components for each topCommentStats state change, we need to make sure we have a placeholder bar el even if this initial batch of reducedTopComments is less than 10 (self.state.topCommentCount)
        for (let barCount = barEls.length; barCount <= self.state.topCommentCount; barCount++) {
            const thisBarElRef = React.createRef();
            barEls.push(
                <BarRaceBar
                    topComment={null}
                    rankOnePoints={self.rankOnePoints}
                    focusTopComment={self.props.focusTopComment}
                    activeTopComment={self.props.focusedTopComment}
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

        self.getRankOnePointScale();

        self.reducedTopComments.forEach((thisTopComment) => { // reducedTopComment is already sorted ascending
            let matchedExistingBarEl = self.barElRefs.find(thisBarRef => {
                if (!thisBarRef.current.state.topComment) return false;
                return thisBarRef.current.state.topComment.id === thisTopComment.id;
            });
            if (matchedExistingBarEl) {
                matchedExistingBarEl.current.setState({
                    topComment: thisTopComment,
                    rankOnePoints: self.rankOnePoints,
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
                    rankOnePoints: self.rankOnePoints,
                    activeTopComment: self.props.focusedTopComment
                });
                updatedBarEls.push(thisBarElRef);
            }
        });

        self.checkBarElsForTextSpace();
    }

    checkBarElsForTextSpace() {
        const self = this;
        self.sortBarElRefs();
        // This function checks every bar el and determines if the bar isn't wide enough to fit symbol text. If so, text will be place just to the right of the bar.
        let foundShortBar = false; // If a single bar is found to be short, then all lower bars will also put text outside (for uniformity)
        self.barElRefs.forEach((thisBarElRef) => { // self.barElRefs are already sorted ascending
            if (foundShortBar) {
                thisBarElRef.current.setState({renderTextOutside: true});
                return;
            }

            const barState = thisBarElRef.current.state;
            if (!barState.topComment || !barState.topComment.rank) return;
            const barLabelEl = document.querySelector(`.topCommentStats_barRace_bar__${barState.topComment.rank} .topCommentStats_barRace_bar_label`);
            const textWrapperEl = document.querySelector(`.topCommentStats_barRace_bar__${barState.topComment.rank} .topCommentStats_barRace_bar_label_text`);
            if (!barLabelEl || !textWrapperEl) return;

            if (textWrapperEl.getBoundingClientRect().width + utils.curMagicScreenMeasure*3 > barLabelEl.getBoundingClientRect().width) {
                // bar is to small, move text and change color
                foundShortBar = true;
                thisBarElRef.current.setState({renderTextOutside: true});
                return;
            }
            thisBarElRef.current.setState({renderTextOutside: false});
        });
    }

    sortBarElRefs() {
        const self = this;
        self.barElRefs.sort((barRefA, barRefB) => {
            let barARank = self.barElRefs.length + 1;
            let barBRank = self.barElRefs.length + 1;
            if (barRefA.current.state.topComment) barARank = barRefA.current.state.topComment.rank;
            if (barRefB.current.state.topComment) barBRank = barRefB.current.state.topComment.rank;
            return barARank - barBRank;
        });
    }

    getRankOnePointScale() {
        const self = this;
        const minSpaceUsageForRankOneBar = 0.9; // min percent of parent container the bar must fill. We let it fluctuate within this margin to allow for a more stable chart that isn't constantly scaling based on rank one point changes.
        const newRankOnePoints = self.reducedTopComments[0].totalPoints['1Hr'];
        if (self.rankOnePoints && newRankOnePoints / self.rankOnePoints <= minSpaceUsageForRankOneBar) {
            self.rankOnePoints = newRankOnePoints;
        } else {
            self.rankOnePoints = Math.max(newRankOnePoints, self.rankOnePoints);
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
        const formattedBody = commentFormatter.formatCommentBody(self.props.focusedTopComment);
        return (
            <div className="topCommentStats_barRace_activeComment" style={css.topCommentStats_barRace_activeCommentInfo}>
                <h6><span style={{'opacity': '0.25'}}>Rank:</span> {commentFormatter.getNumberOrdinal(self.props.focusedTopComment.rank)}</h6>
                <h2 style={css.topCommentStats_barRace_activeCommentInfo_symbolTitle} dangerouslySetInnerHTML={{ __html: topSymbolName }}></h2>
                <h6 style={{'opacity': '0.25'}}>Top Comment:</h6>
                <h5 style={css.topCommentStats_barRace_activeCommentInfo_bodyText} dangerouslySetInnerHTML={{ __html: formattedBody }}></h5>
                <span style={css.topCommentStats_barRace_activeCommentInfo_author}>@{self.props.focusedTopComment.author.name || ''}</span>
                <div style={css.topCommentStats_barRace_activeCommentInfo_actionBtn}>
                    <button className="button__sev1 button__light" onClick={self.props.gNav.showSetTrendActionModal.bind(self.props.gNav)}>
                        <Icon iconName="data_saver_on" height="100%" />
                        Action
                    </button>
                </div>
            </div>
        )
    }

    render() {
        const self = this;
        const css = styles.generate(self);

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
