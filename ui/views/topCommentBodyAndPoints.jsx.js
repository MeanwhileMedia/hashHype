import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import MsgBox from './msgBox.jsx.js'
import Icon from './hbWidgets/icon.jsx.js'

import utils from '../helpers/utils.js'
import commentFormatter from '../helpers/commentFormatter.js'

import styles from './styles/topCommentBodyAndPoints.css.js';

class TopCommentBodyAndPoints extends React.Component {
    constructor(props) {
        super(props);

        this.state = {
            expandPointsInfo: false, //whether or not the points info msgBox is visible. Same prop name can also be passed to this component as a prop.
            activePointsInfoWordIndex: -1, // set to -1 and the pointsInfo el will show summary text. Otherwise it shows info for the wordRef at this index in this.pointedWordRefs
            prevActivePointsInfoWordIndex: null // we track this so we can determine when the msgBox was newly opened
        };
        this.pointedWordRefs = [];

        this.tokenBoundaries = `[^A-Za-zА-Яа-я0-9_'’]`; // IF MODIFYING DO A GLOBAL REPLACE. This is set to the same tokenizer used in extractWordsFromComments
        this.uid = 1; // just an incremented uid used associate dom elements with wordRefs
    }

    componentDidUpdate(prevProps, prevState) {
        const self = this;
        if (prevProps.topComment !== this.props.topComment) { // we always hide the pointsInfo msgBox upon active comment change
            self.togglePointsInfo(false);
            self.resetActivePointsInfoWordIndex();
        }
    }

    resetActivePointsInfoWordIndex() {
        document.querySelectorAll('.topCommentBodyAndPoints_bodyLayer__primary').forEach(el => el.style.opacity = '1');
        document.querySelectorAll('.topCommentBodyAndPoints_bodyLayer .topCommentBodyAndPoints_bodyLayer_word').forEach(el => el.classList.add('font__heavy__noExpand__black'));
        if (this.state.activePointsInfoWordIndex !== -1) {
            this.setState({
                activePointsInfoWordIndex: -1,
                prevActivePointsInfoWordIndex: null
            }); // reset to start anytime the infoEl is re-hidden
        }
    }

    togglePointsInfo(isVisible = null) {
        if (isVisible === null) isVisible = !this.state.expandPointsInfo;
        if (this.state.expandPointsInfo !== isVisible) {
            this.setState({expandPointsInfo: isVisible});
            if (isVisible === false) this.resetActivePointsInfoWordIndex();
        }
    }

    highlightCommentBody() { // Adds underlines and other illustration to show why a comment body has value/points.
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return null;
        const css = styles.generate(self);

        const clickedBodyLayer = (e) => {
            const elsBeneathCursor = document.elementsFromPoint(e.clientX, e.clientY);
            let targetWordEl = elsBeneathCursor.find((thisEl) => thisEl.classList.contains('topCommentBodyAndPoints_bodyLayer_word'));
            if (!targetWordEl) return;

            const parentBodyLayer = targetWordEl.closest('.topCommentBodyAndPoints_bodyLayer');
            if (!parentBodyLayer) return;
            let targetBodyLayerUid = parentBodyLayer.getAttribute('bodyLayerUid');
            if (!targetBodyLayerUid) return;
            targetBodyLayerUid = parseInt(targetBodyLayerUid); // convert back to int

            const thisWordRefIndex = self.pointedWordRefs.findIndex((thisWordRef) => thisWordRef.bodyElUid === targetBodyLayerUid);
            if (thisWordRefIndex === -1) return;
            self.setState({
                activePointsInfoWordIndex: thisWordRefIndex,
                prevActivePointsInfoWordIndex: this.state.activePointsInfoWordIndex
            });
            self.togglePointsInfo(true);
        };

        const highlightedCommentBody = (
            <div style={css.topCommentBodyAndPoints_bodyLayers} onClick={clickedBodyLayer}>
                <span className="topCommentBodyAndPoints_bodyLayer topCommentBodyAndPoints_bodyLayer__primary" style={css.topCommentBodyAndPoints_bodyLayer__primary} dangerouslySetInnerHTML={{__html: self.renderEmojisInBody(comment.body)}}></span>
                {self.getHighlightedPointWordEls()}
                {self.getHighlighted2dGramEls()}
            </div>
        );

        return highlightedCommentBody;
    }

    onPointsInfoCarouselClick(direction, e) {
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return;

        self.getOrderedPointedWordRefs();

        let newActivePointsInfoWordIndex;
        if (direction === 'back') {
            newActivePointsInfoWordIndex = self.state.activePointsInfoWordIndex - 1;
            if (newActivePointsInfoWordIndex < -1) newActivePointsInfoWordIndex = self.pointedWordRefs.length-1;
        } else {
            newActivePointsInfoWordIndex = self.state.activePointsInfoWordIndex + 1;
            if (newActivePointsInfoWordIndex > self.pointedWordRefs.length-1) {
                newActivePointsInfoWordIndex = -1;
                self.resetActivePointsInfoWordIndex();
            }
        }
        this.setState({
            activePointsInfoWordIndex: newActivePointsInfoWordIndex,
            prevActivePointsInfoWordIndex: this.state.activePointsInfoWordIndex
        })
    }

    getOrderedPointedWordRefs() {
        const self = this;
        self.pointedWordRefs = [];
        for (const [pointedWordStr, points] of Object.entries(self.props.topComment.pointsAdjust)) {
            if (points) {
                const thisPointedWordRef = self.props.topComment.words[pointedWordStr];
                thisPointedWordRef.bodyElUid = thisPointedWordRef.bodyElUid || ++self.uid; // save for later (points info msgbox)
                self.pointedWordRefs.push(thisPointedWordRef);
            }
        }
        self.pointedWordRefs.sort((a, b) => {
            const aTotalPoints = self.props.topComment.pointsAdjust[a.word] || 0;
            const bTotalPoints = self.props.topComment.pointsAdjust[b.word] || 0;
            if (aTotalPoints > bTotalPoints) return -1;
            if (aTotalPoints < bTotalPoints) return 1;
            return 0;
        });
        if (!self.pointedWordRefs[self.state.activePointsInfoWordIndex]) self.resetActivePointsInfoWordIndex();
    }

    getHighlightedPointWordEls() {
        // We will bold any word sequences which earned points for this comment (NOT word sequence clusers (2dGrams) - they get their own visual treatment below).
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return null;
        const css = styles.generate(self);

        self.getOrderedPointedWordRefs();

        const highlightedPointWordEls = [];
        const alreadyBoldedWords = [];
        self.pointedWordRefs.forEach((thisPointedWordRef) => {
            const sortedRawWords = [...thisPointedWordRef.rawWords].sort((a,b) => b.length - a.length); // sort large to small to assist our overlap logic below
            const alreadyBoldedWords = [];
            sortedRawWords.forEach((thisRawWordSeqStr) => {
                let isOverlapWord = false;
                alreadyBoldedWords.some((thisAlreadyBoldedWord) => {
                    if (thisAlreadyBoldedWord.indexOf(thisRawWordSeqStr) !== -1) {
                        isOverlapWord = true;
                        return true; // break loop
                    }
                });
                if (isOverlapWord) return;

                const findWordWithBoundariesNotSpaces = self.replaceSpacesWithTokenBoundariesInRegexString(thisRawWordSeqStr);
                const wordTokenizerRegex = new RegExp(`(${self.tokenBoundaries}|^)(${findWordWithBoundariesNotSpaces})(${self.tokenBoundaries}|$)`, 'gm'); // https://regexr.com/6cmqg
                let thisCommentBody = comment.body.replaceAll(wordTokenizerRegex, `$1<span class="topCommentBodyAndPoints_bodyLayer_word font__heavy__noExpand__black" style="border-bottom: 4px solid rgba(0,0,0,0.1);">$2</span>$3`)
                if (thisCommentBody === comment.body) {
                    console.warn(`Could not find ${thisRawWordSeqStr} in comment body: ${comment.body}`);
                    return; // apparently no replacement was made
                }
                alreadyBoldedWords.push(thisRawWordSeqStr);

                const emojiStyles = {allEmojis: {opacity: 0}}; // All emojis in this bodyLayer should have 0 opacity (just like the text) EXCEPT for if this bolded word is an emoji (then must have opacity 1)
                const thisRawWordSeqStrIsEmoji = comment.symbols.find(thisSymbol => thisSymbol.name === thisRawWordSeqStr);
                if (thisRawWordSeqStrIsEmoji) emojiStyles[thisRawWordSeqStr] = {opacity: 1};
                thisCommentBody = self.renderEmojisInBody(thisCommentBody, emojiStyles);

                highlightedPointWordEls.push((
                    <span className={`topCommentBodyAndPoints_bodyLayer topCommentBodyAndPoints_bodyLayer__${thisPointedWordRef.bodyElUid}`} bodyLayerUid={thisPointedWordRef.bodyElUid} style={css.topCommentBodyAndPoints_bodyLayer} dangerouslySetInnerHTML={{__html: thisCommentBody}}>
                    </span>
                ));

            });
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
        for (let [wordStr, pointsForWord] of Object.entries(comment.pointsAdjust)) {
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
            const foundRawWordCount = 0;
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

            let allPossibleRawWordIndexCombos = [];
            if (sortedRawWordIndexes.length <= reducedRawWords.length) {
                // We only found one (or less) occurance of each rawWord. We don't need to proceed with finding the tightest possible cluster of all the rawWWords (there's only one possible cluster).
                allPossibleRawWordIndexCombos = [sortedRawWordIndexes];
            } else {
                const possibleRawWordCombosCount = sortedRawWordIndexes.length - reducedRawWords.length + 1;
                for (let thisTokenInsetCount = 0; thisTokenInsetCount < possibleRawWordCombosCount; thisTokenInsetCount++) {
                    allPossibleRawWordIndexCombos.push(sortedRawWordIndexes.slice(thisTokenInsetCount, thisTokenInsetCount + reducedRawWords.length));
                }
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
            let thisCommentBody = bodyFirstHalf + bodySecondHalf.replace(spanned2dGramStr, `<span class="topCommentBodyAndPoints_bodyLayer_word" style="padding-bottom: 6px; border-bottom: 4px solid rgba(255, 149, 151, ${underlineOpacity}); position: relative;">${leftBracketEl}${spanned2dGramStr}${rightBracketEl}</span>`);
            thisCommentBody = self.renderEmojisInBody(thisCommentBody);

            highlighted2dGramEls.push((
                <span className={`topCommentBodyAndPoints_bodyLayer topCommentBodyAndPoints_bodyLayer__${thisPointedWordRef.bodyElUid}`} bodyLayerUid={thisPointedWordRef.bodyElUid} style={css.topCommentBodyAndPoints_bodyLayer} dangerouslySetInnerHTML={{__html: thisCommentBody}}>
                </span>
            ));

            thisPointedWordRef.spanned2dGramStr = spanned2dGramStr; // save for later (points info msgbox)
        };

        return highlighted2dGramEls;
    }

    renderEmojisInBody(thisCommentBody, perEmojiStyles = {}) { // returns a copy of thisCommentBody. Does not alter thisCommentBody in-place.
        // perEmojiStyles is object {':4271:': {opacity: 0.5, etc}, allEmojis: {}, etc}
        // "allEmojis" will apply styles at that key to all emojis in thisCommentBody. In the case of example above, ONLY perEmojiStyles[':4271:'] would be applied to :4271: (taking precedence over allEmojis)
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return null;

        // Make sure symbols are properly rendered for this bodyLayer too
        let commentBodyClone = `${thisCommentBody}`;
        comment.symbols.forEach((thisSymbol) => {
            const thisSymbolAssocHtml = commentFormatter.getEmojiAssocHtml(thisSymbol);
            if (!thisSymbolAssocHtml) return;

            const tempEmojiEl = document.createElement('div');
            tempEmojiEl.innerHTML = thisSymbolAssocHtml;

            let applyStyles = perEmojiStyles[thisSymbol.name];
            if (!applyStyles) applyStyles = perEmojiStyles['allEmojis'];
            if (applyStyles) {
                const emojiWrapperEl = tempEmojiEl.querySelector('.emoji');
                if (emojiWrapperEl) {
                    for (let [styleName, styleVal] of Object.entries(applyStyles)) {
                        emojiWrapperEl.style[styleName] = styleVal;
                    }
                }
            }

            if (tempEmojiEl.innerHTML) commentBodyClone = commentBodyClone.replaceAll(thisSymbol.symbol, tempEmojiEl.innerHTML);
        });

        return commentBodyClone;
    }

    replaceSpacesWithTokenBoundariesInRegexString(regexString) {
        // Since our tokenizer in extractWordsFromComments removed punctation when extracting raw words, a search later for those rawWords
        // will be -1 if the rawWords in body are actually seperated by anything other than a space.
        // I.e: The rawWord is "GME ask", but the comment body is "I love GME. ask anyone."
        // That's why when we build the regex to find "GME ask", we replace the space with a search for one or more token boundaries.
        const regexStringBoundariesNotSpaces = regexString.replaceAll(' ', `${this.tokenBoundaries}+`); // https://regexr.com/6cmqg
        return regexStringBoundariesNotSpaces;
    }

    getPointsInfoEl() {
        const self = this;
        const comment = this.props.topComment;
        if (!comment || !comment.body) return null;
        const css = styles.generate(self);

        let thisPointedWordRef = null;;
        self.getOrderedPointedWordRefs();

        let pointedWordCount = 0;
        let totalOtherUserCount = 0; // how many other users (total) commented the pointed words in this comment.
        for (const [pointedWordStr, points] of Object.entries(self.props.topComment.pointsAdjust)) {
            if (!points) continue;
            ++pointedWordCount;
            const unadjustedPoints = self.props.topComment.points[pointedWordStr];
            totalOtherUserCount = totalOtherUserCount + (unadjustedPoints/self.props.topComment.words[pointedWordStr].pointVal);
        }
        totalOtherUserCount = Math.ceil(totalOtherUserCount);

        const overallPointsSummary = (
            <p style={css.topCommentBodyAndPoints_pointsInfo_body}>This comment is ranked
                {' '}<b>{commentFormatter.getNumberOrdinal(self.props.topComment.rankRender)}</b>
                {' '}because it contains
                {' '}<b>{pointedWordCount}</b>
                {' '}<span style={{'border-bottom': '4px solid rgba(0,0,0,0.1)'}}>phrases</span>
                {' '}which were recently commented by
                {' '}<b>{totalOtherUserCount}</b>
                {' '}other users.
            </p>
        );

        let thisPointsExplanation = null;
        if (self.state.activePointsInfoWordIndex === -1) {
            thisPointsExplanation = overallPointsSummary;
        } else {
            thisPointedWordRef = self.pointedWordRefs[self.state.activePointsInfoWordIndex];
            if (!thisPointedWordRef) {
                self.togglePointsInfo(false);
                self.resetActivePointsInfoWordIndex();
                return null;
            }

            let underlineColor = 'rgba(0,0,0,0.1)';

            let thisPhraseType = 'phrase';
            if (thisPointedWordRef.type === '2dGram') {
                thisPhraseType = 'word sequence';
                underlineColor = 'rgba(255, 149, 151, 0.4)';
            }
            if (thisPointedWordRef.hasSymbols.length && thisPointedWordRef.word.split('_!!_').length === 1) {
                const thisSymbol = self.props.topComment.symbols.find(thisSymbol => {
                    return thisSymbol.key === thisPointedWordRef.hasSymbols[0];
                });
                thisPhraseType = `${thisSymbol.type} symbol`;
            }

            let shortestRawWord = null;
            thisPointedWordRef.rawWords.forEach((thisRawWord) => {
                if (shortestRawWord === null || thisRawWord.length < shortestRawWord.length) shortestRawWord = thisRawWord;
            })
            if (thisPointedWordRef.spanned2dGramStr) {
                shortestRawWord = thisPointedWordRef.spanned2dGramStr;
                const spannedWordsNotPointed = [];
                shortestRawWord.split(new RegExp(self.tokenBoundaries)).forEach((thisToken) => {
                    let isUnpointedToken = true;
                    thisPointedWordRef.rawWords.some((thisRawWord) => {
                        if (thisRawWord.indexOf(thisToken) !== -1) {
                            isUnpointedToken = false;
                            return true; // break loop
                        }
                    });
                    if (isUnpointedToken) shortestRawWord = shortestRawWord.replace(thisToken, '[...]');
                });
                shortestRawWord = shortestRawWord.replaceAll(new RegExp(/\[\.\.\.[^A-Za-zА-Яа-я0-9]+]/, 'g'), '[...]'); // In case we have multiple non-pointed spanned words in sequence, use only one '[...]' https://regexr.com/6chcs
            }

            thisPointsExplanation = (
                <p style={css.topCommentBodyAndPoints_pointsInfo_body}>The {thisPhraseType}
                    {' '}"<span style={{'border-bottom': `4px solid ${underlineColor}`}}><b dangerouslySetInnerHTML={{__html: self.renderEmojisInBody(shortestRawWord)}}></b></span>"
                    {' '}is the
                    {' '}<b>{commentFormatter.getNumberOrdinal(self.state.activePointsInfoWordIndex+1)}</b>
                    {' '}most important phrase in this comment.
                </p>
            );
        }

        if (thisPointedWordRef) {
            document.querySelectorAll('.topCommentBodyAndPoints_bodyLayer .topCommentBodyAndPoints_bodyLayer_word').forEach(el => el.classList.remove('font__heavy__noExpand__black'));
            document.querySelectorAll(`.topCommentBodyAndPoints_bodyLayer__${thisPointedWordRef.bodyElUid} .topCommentBodyAndPoints_bodyLayer_word`).forEach(el => el.classList.add('font__heavy__noExpand__black'));
            document.querySelectorAll('.topCommentBodyAndPoints_bodyLayer__primary').forEach(el => el.style.opacity = '0.4');
        }

        if (this.state.activePointsInfoWordIndex !== -1 && this.state.prevActivePointsInfoWordIndex == -1) {
            // Looks like the user clicked directly on a word to newly open the msgBox. Just once, we will show the overall points summary alongside the individual word points explanation.
            thisPointsExplanation = [overallPointsSummary, thisPointsExplanation];
        }

        const pointsInfoEl = (
            <div style={css.topCommentBodyAndPoints_pointsInfo}>
                <MsgBox body={thisPointsExplanation} hidden={!this.state.expandPointsInfo} isCarousel={true} onCarouselClick={self.onPointsInfoCarouselClick.bind(self)}/>
            </div>
        );

        return pointsInfoEl;
    }

    getAuthorEl() {
        const css = styles.generate(self);
        if (this.state.expandPointsInfo) return null;
        let renderAuthorName = this.props.topComment.author.name;
        if (this.props.topComment.isQuoted && this.props.topComment.quotedAuthor && this.props.topComment.quotedAuthor.name) {
            renderAuthorName = this.props.topComment.quotedAuthor.name;
        }
        return (
            <span style={css.topCommentBodyAndPoints_author}>@{renderAuthorName}</span>
        )
    }

    render() {
        const self = this;
        if (!this.props.topComment) return null;

        const css = styles.generate(self);

        const commentBodyEl = self.highlightCommentBody();
        const pointsInfoEl = self.getPointsInfoEl();
        const authorEl = self.getAuthorEl();

        return (
            <div className="topCommentBodyAndPoints" style={css.topCommentBodyAndPoints}>
                 <h5>{commentBodyEl}</h5>
                 {pointsInfoEl}
                 {authorEl}
            </div>
        );
    }

} // end view

export default Radium(TopCommentBodyAndPoints);
