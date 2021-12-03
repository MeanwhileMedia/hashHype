import React from '/node_modules/react';
import Radium from '/node_modules/radium';

import styles from './styles/barRace.css.js';

class BarRace extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            topCommentCount: 10, // how many topComments to show in our wheel
            showOnlyTopCommentsWithSymbols: true, // don't display an comments on our wheel unless they are associated with at least one symbol
            showTopCommentSymbolsOnlyOnce: true, // our server will send a max of 2 comments to represent any single symbol. Set this true and we will only render the higher scoring one. Will only apply when showOnlyTopCommentsWithSymbols == true.
            showTopCommentSymbolTypes: ['stock'], // can be set to one or more of strings equaling a symbol.type
        };

        this.activeTopComment = null;
        this.reducedTopComments = []; // the comments after passing through above state filters
        this.barColorPallette = ["#f94144","#f3722c","#f8961e","#f9844a","#f9c74f","#90be6d","#43aa8b","#4d908e","#577590","#277da1"]; //https://coolors.co/palettes/trending
    }

    componentDidMount() {
        this.props.setPageIsReady();
    }

    componentDidUpdate() {
        if (this.lastUpdated === this.props.topCommentsLastUpdated) return; // we only need to run the below after we have received new stats:topComments from the server
        this.lastUpdated = this.props.topCommentsLastUpdated;
    }

    reduceTopComments() {
        const self = this;
        let reducedTopComments = [];
        let allPointCounts = []; // for setting color and width of topCommentWheelParts

        if (this.state.showOnlyTopCommentsWithSymbols) {
            const reducedTopCommentsBySymbol = {}; // {GME: [comment3, comment1], APPL: [comment32], etc..} - used for picking the higher scoring symbol comment when showTopCommentSymbolsOnlyOnce == true
            this.props.topComments.forEach((thisTopComment) => {
                const hasTopSymbolKey = thisTopComment.topSymbolHigh['1Hr'].key || thisTopComment.topSymbolLow['1Hr'].key || null;
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
        }
        if (reducedTopComments.length === 0) { return []; }

        let confirmedActiveTopComment = false;
        reducedTopComments.sort((a, b) => b.totalPoints['1Hr'] - a.totalPoints['1Hr']);
        reducedTopComments = reducedTopComments.slice(0, this.state.topCommentCount);
        reducedTopComments.forEach( (topComment, index) => {
            topComment.rank = index+1;
            if (self.activeTopComment && topComment.id === self.activeTopComment.id) confirmedActiveTopComment = true; // after a re-render, confirm that the comment marked as actively selected is actually still rendered.
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

        // Either the previous active comment was no longer rendered, or this is page load and no comment has been activated yet. By default, set rank 1 comment active.
        if (!confirmedActiveTopComment) self.activeTopComment = reducedTopComments[0];

        return reducedTopComments;
    }

    createBarEls() {
        const self = this;
        const barEls = [];
        if (!self.reducedTopComments.length) return barEls;
        const css = styles.generate(self);

        const rankOnePoints = self.reducedTopComments[0].totalPoints['1Hr'];
        self.reducedTopComments.forEach((thisTopComment) => { // reducedTopComment is already sorted descending
            const thisCommentPoints = thisTopComment.totalPoints['1Hr'];
            let thisCommentIsActive = false;
            if (self.activeTopComment && self.activeTopComment.id === thisTopComment.id) thisCommentIsActive = true;

            let symbolText = '';
            let thisCommentTopSymbol = thisTopComment.topSymbolHigh['1Hr'].key || thisTopComment.topSymbolLow['1Hr'].key || null;
            if (thisCommentTopSymbol) {
                thisTopComment.symbols.forEach((thisSymbol) => {
                    const thisSymbolKey = `symbol:${thisSymbol.type}:${thisSymbol.symbol}`;
                    if (thisSymbolKey === thisCommentTopSymbol) thisCommentTopSymbol = thisSymbol;
                });
                symbolText = thisCommentTopSymbol.symbol;
                thisTopComment.renderedSymbol = thisCommentTopSymbol; // save on comment object for easy access by other classes
            } else {
                symbolText = '';
            }
            const zBasedRank = thisTopComment.rank - 1;
            let theseStyles = {
                'top': `${(css.barHeight*zBasedRank)+(css.barSpaceBetween*zBasedRank)}rem`,
                'width': `${(thisCommentPoints/rankOnePoints)*100}%`,
                'background-color': self.barColorPallette[zBasedRank]
            };
            if (thisCommentIsActive) theseStyles = Object.assign({}, css.topCommentStats_barRace_bar__active, theseStyles);

            barEls.push((
                <li className="topCommentStats_barRace_bar" style={Object.assign({}, css.topCommentStats_barRace_bar, theseStyles)} onClick={(e) => { self.props.focusTopComment(thisTopComment.id) } }>
                    <h2 className="topCommentStats_barRace_bar_label" style={css.topCommentStats_barRace_bar_label}>{symbolText}</h2>
                </li>
            ));
        });
        return barEls;
    }

    render() {
        const self = this;
        const css = styles.generate(self);
        self.activeTopComment = self.props.topComments.find(topComment => topComment.isFocused);
        self.reducedTopComments = self.reduceTopComments();
        if (self.activeTopComment && self.activeTopComment.id !== self.props.focusedTopComment) self.props.focusTopComment(self.activeTopComment.id);

        const bars = self.createBarEls();
        return (
            <div className="topCommentStats_barRace" style={css.topCommentStats_barRace}>
                <ul className="topCommentStats_barRace_bars" style={css.topCommentStats_barRace_bars}>
                    {bars}
                </ul>
                <div className="topCommentStats_barRace_activeComment" style={css.topCommentStats_barRace}>
                    // JWW stopping
                </div>
            </div>
        );
    }

} // end view

export default Radium(BarRace);
