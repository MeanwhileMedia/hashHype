import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import MsgBox from './msgBox.jsx.js'
import utils from '../helpers/utils.js'
import commentFormatter from '../helpers/commentFormatter.js'

import styles from './styles/topCommentBodyAndPoints.css.js';

class TopCommentBodyAndPoints extends React.Component {
    constructor(props) {
        super(props);
        this.tokenBoundaries = `[^A-Za-zА-Яа-я0-9_'’]`; // IF MODIFYING DO A GLOBAL REPLACE. This is set to the same tokenizer used in extractWordsFromComments
    }

    highlightCommentBody() { // Adds underlines and other illustration to show why a comment body has value/points.
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return null;
        const css = styles.generate(self);

        const highlightedCommentBody = (
            <div style={css.topCommentBodyAndPoints_bodyLayers}>
                <span style={css.topCommentBodyAndPoints_bodyLayer__primary}>{self.renderEmojisInBody(comment.body)}</span>
                {self.getHighlightedPointWordEls()}
                {self.getHighlighted2dGramEls()}
            </div>
        );

        return highlightedCommentBody;
    }

    getHighlightedPointWordEls() {
        // We will bold any word sequences which earned points for this comment (NOT word sequence clusers (2dGrams) - they get their own visual treatment below).
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return null;
        const css = styles.generate(self);

        let boldTheseWordSeqs = [];
        for (let [wordStr, pointsForWord] of Object.entries(comment.points['1Hr'])) {
            if (!pointsForWord) continue;
            const thisPointedWordRef = comment.words[wordStr];
            // if (thisPointedWordRef.type !== '2dGram') boldTheseWordSeqs = boldTheseWordSeqs.concat(thisPointedWordRef.rawWords);
            boldTheseWordSeqs = boldTheseWordSeqs.concat(thisPointedWordRef.rawWords);
        };
        boldTheseWordSeqs.sort((a,b) => b.length - a.length); // sort large to small to assist our overlap logic below

        const highlightedPointWordEls = [];
        const alreadyBoldedWords = [];
        boldTheseWordSeqs.forEach((thisRawWordSeqStr) => {

            if (alreadyBoldedWords.indexOf(thisRawWordSeqStr) !== -1) return;
            let isOverlapWord = false;
            alreadyBoldedWords.some((thisAlreadyBoldedWord) => {
                if (thisAlreadyBoldedWord.indexOf(thisRawWordSeqStr) !== -1) {
                    isOverlapWord = true;
                    return true; //break loop
                }
            });
            if (isOverlapWord) return;
            alreadyBoldedWords.push(thisRawWordSeqStr);

            const wordTokenizerRegex = new RegExp(`(${self.tokenBoundaries}|^)${thisRawWordSeqStr}(${self.tokenBoundaries}|$)`, 'gm'); // https://regexr.com/6bhjs
            let thisCommentBody = comment.body.replaceAll(wordTokenizerRegex, `$1<span class="font__heavy__noExpand" style="border-bottom: 4px solid rgba(0,0,0,0.1);">${thisRawWordSeqStr}</span>$2`)
            thisCommentBody = self.renderEmojisInBody(thisCommentBody);

            highlightedPointWordEls.push((
                <span style={css.topCommentBodyAndPoints_bodyLayer} dangerouslySetInnerHTML={{__html: thisCommentBody}}>
                </span>
            ));
        });

        return highlightedPointWordEls;
    }

    getHighlighted2dGramEls() {
        // Apply visuals to 2dGrams
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return null;
        const css = styles.generate(self);

        const highlighted2dGramEls = [];
        for (let [wordStr, pointsForWord] of Object.entries(comment.points['1Hr'])) {
            if (!pointsForWord) continue;
            const thisPointedWordRef = comment.words[wordStr];
            if (thisPointedWordRef.type !== '2dGram') continue;
            const startAtIndex = thisPointedWordRef.rawIndex[0] || 0;
            if (typeof startAtIndex !== 'number') continue;
            // Attempt to determine the maximum set of characters within comment body that can represent this 2dGram, then underline all those chars. To do this,

            // 1. Isolate the portion of the string that we know will not include any of this 2dGram using the wordRef.index
            const bodyFirstHalf = comment.body.slice(0, startAtIndex);
            const bodySecondHalf = comment.body.slice(startAtIndex); // now we only need to search bodySecondHalf for words to augment

            // 2. Condense/reduce all of the rawWords
            const reducedRawWords = [...new Set(thisPointedWordRef.rawWords.join(' ').split(' '))]; // we search for each token individually because our rawWords seqs won't include punction present in comment.body

            // 3. Extract the portion of comment.body which best represents the set of rawWords associated with this 2dGram
            // - Get all of our rawWords (individual tokens) and collect all indexes of found occurances within comment.body.
            // - Remove duplicates, sort ascending.
            // - The set of indexes we keep can not have length greater than number of rawWords
            // - select the grouping of index integers with the lowest range
            const rawWordIndexes = []; // [{index: int, rawWord: string}, etc]
            reducedRawWords.forEach((thisRawWord) => {
                const foundAtIndexes = [...bodySecondHalf.matchAll(new RegExp(`(${self.tokenBoundaries}|^)${thisRawWord}(${self.tokenBoundaries}|$)`, 'g'))].map(a => {
                    let index = a.index + 1; // +1 to exclude the tokenBoundaries char
                    if (a.index === 0) index = a.index;
                    return index;
                });
                foundAtIndexes.forEach((thisIndexInt) => {
                    rawWordIndexes.push({index: thisIndexInt, rawWord: thisRawWord});
                });
            });
            const dedupedRawWordIndexes = {};
            rawWordIndexes.forEach((thisRawWordIndex) => {
                if (!dedupedRawWordIndexes[thisRawWordIndex.index]) dedupedRawWordIndexes[thisRawWordIndex.index] = thisRawWordIndex;
            });
            let sortedRawWordIndexes = Object.values(dedupedRawWordIndexes);
            sortedRawWordIndexes.sort((a, b) => {
                if (a.index < b.index) return -1;
                if (a.index > b.index) return 1;
                return 0;
            });
            const allPossibleRawWordIndexCombos = [];
            const possibleRawWordCombosCount = sortedRawWordIndexes.length - reducedRawWords.length + 1;
            for (let thisTokenInsetCount = 0; thisTokenInsetCount < possibleRawWordCombosCount; thisTokenInsetCount++) {
                allPossibleRawWordIndexCombos.push(sortedRawWordIndexes.slice(thisTokenInsetCount, thisTokenInsetCount + reducedRawWords.length));
            }
            allPossibleRawWordIndexCombos.sort((a, b) => {
                const aIndexSpan = a[a.length-1].index - a[0].index;
                const bIndexSpan = b[b.length-1].index - b[0].index;
                if (aIndexSpan < bIndexSpan) return -1;
                if (aIndexSpan > bIndexSpan) return 1;
                return 0;
            });
            const closestRawWordCluster = allPossibleRawWordIndexCombos[0];

            // 4. Take our rawWord index span and try to wrap that portion of comment.body in our style wrapper el (and apply penalties to the underline opacity)
            const spanned2dGramStr = bodySecondHalf.slice(closestRawWordCluster[0].index, closestRawWordCluster[closestRawWordCluster.length-1].index + closestRawWordCluster[closestRawWordCluster.length-1].rawWord.length);

            const spannedExtraRawWords = []; // these are the words included in spanned2dGramStr which ARE NOT present in 2dGram.rawWords. It's a measure of how much extra information is being drawn from this 2dGram.
            spanned2dGramStr.split(new RegExp(self.tokenBoundaries)).forEach((thisSpannedRawWord) => {
                if (reducedRawWords.indexOf(thisSpannedRawWord) === -1) spannedExtraRawWords.push(thisSpannedRawWord);
            });
            const spannedExtraRawWordsDistance = spannedExtraRawWords.join(' ').length;
            let extraSpanPenalty = 1
            if (spannedExtraRawWordsDistance < thisPointedWordRef.word.length) {
                extraSpanPenalty = spannedExtraRawWordsDistance / thisPointedWordRef.word.length;
            }

            let underlineOpacity = 0;
            if (typeof thisPointedWordRef.distance === 'number') {
                underlineOpacity = 0.6-extraSpanPenalty;
                underlineOpacity = Math.max(underlineOpacity, .15); // if we don't set a min opacity we lose the viz in some cases
            }

            const leftBracketEl = `<span style="display: inline-block; height: 12px; margin-bottom: -1.22rem; margin-left: -4px; border-left: 4px solid rgba(255, 149, 151, ${underlineOpacity});"></span>`;
            const rightBracketEl = `<span style="display: inline-block; height: 12px; margin-bottom: -1.22rem; margin-right: -4px; border-right: 4px solid rgba(255, 149, 151, ${underlineOpacity});"></span>`;
            let thisCommentBody = bodyFirstHalf + bodySecondHalf.replace(spanned2dGramStr, `<span style="padding-bottom: 6px; border-bottom: 4px solid rgba(255, 149, 151, ${underlineOpacity}); position: relative;">${leftBracketEl}${spanned2dGramStr}${rightBracketEl}</span>`);
            thisCommentBody = self.renderEmojisInBody(thisCommentBody);

            highlighted2dGramEls.push((
                <span style={css.topCommentBodyAndPoints_bodyLayer} dangerouslySetInnerHTML={{__html: thisCommentBody}}>
                </span>
            ));
        };

        return highlighted2dGramEls;
    }

    renderEmojisInBody(thisCommentBody) { // returns a copy of thisCommentBody. Does not alter thisCommentBody in-place.
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return null;

        // Make sure symbols are properly rendered for this bodyLayer too
        let commentBodyClone = `${thisCommentBody}`;
        comment.symbols.forEach((thisSymbol) => {
            const thisSymbolAssocHtml = commentFormatter.getEmojiAssocHtml(thisSymbol);
            if (thisSymbolAssocHtml) commentBodyClone = commentBodyClone.replaceAll(thisSymbol.symbol, thisSymbolAssocHtml);
        });

        return commentBodyClone;
    }

    render() {
        const self = this;
        if (!this.props.topComment) return null;

        const css = styles.generate(self);

        const commentBodyEl = self.highlightCommentBody();

        let pointsInfoElIsHidden = true;
        if (this.props.expandPointsInfo) {
            pointsInfoElIsHidden = false;
        }
        const thisPointsExplanation = (
            <div>Foo Bar</div>
        );
        const pointsInfoEl = (
            <div style={css.topCommentBodyAndPoints_pointsInfo}>
                <MsgBox body={thisPointsExplanation} hidden={pointsInfoElIsHidden} />
            </div>
        );

        return (
            <div className="topCommentBodyAndPoints" style={css.topCommentBodyAndPoints}>
                 <h5>{commentBodyEl}</h5>
                 {pointsInfoEl}
            </div>
        );
    }

} // end view

export default Radium(TopCommentBodyAndPoints);
