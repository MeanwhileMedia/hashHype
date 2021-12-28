// Functions to prep comment data for rendering
const commentFormatter = {

    formatCommentBody: (comment) => { // returns HTML string
        if (!comment || !comment.body) return '';
        const tokenBoundaries = `[^A-Za-zА-Яа-я0-9_'’]`; // IF MODIFYING DO A GLOBAL REPLACE. This is set to the same tokenizer used in extractWordsFromComments

        let formattedBody = `<div style="position: relative"><span style="display: inline-block; width: 100%;">${comment.body}</span>`;

        // 1. We will bold any word sequences which earned points for this comment (NOT word sequence clusers (2dGrams) - they get their own visual treatment below).
        let boldTheseWordSeqs = [];
        for (let [wordStr, pointsForWord] of Object.entries(comment.points['1Hr'])) {
            if (!pointsForWord) continue;
            const thisPointedWordRef = comment.words[wordStr];
            // if (thisPointedWordRef.type !== '2dGram') boldTheseWordSeqs = boldTheseWordSeqs.concat(thisPointedWordRef.rawWords);
            boldTheseWordSeqs = boldTheseWordSeqs.concat(thisPointedWordRef.rawWords);
        };
        boldTheseWordSeqs.sort((a,b) => b.length - a.length); // sort large to small to assist our overlap logic below
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

            const wordTokenizerRegex = new RegExp(`(${tokenBoundaries}|^)${thisRawWordSeqStr}(${tokenBoundaries}|$)`, 'gm'); // https://regexr.com/6bhjs
            formattedBody = formattedBody +
                '<span style="position: absolute; top: 0; left: 0; width: 100%; color: rgba(0,0,0,0); z-index: -1;">' +
                comment.body.replaceAll(wordTokenizerRegex, `$1<span class="font__heavy__noExpand" style="border-bottom: 4px solid rgba(0,0,0,0.1);">${thisRawWordSeqStr}</span>$2`) +
                '</span>';
        });

        // 2. Next apply visuals to 2dGrams
        for (let [wordStr, pointsForWord] of Object.entries(comment.points['1Hr'])) {
            if (!pointsForWord) continue;
            const thisPointedWordRef = comment.words[wordStr];
            if (thisPointedWordRef.type !== '2dGram') continue;
            // const startAtIndex = thisPointedWordRef.index[0];
            // if (typeof startAtIndex !== 'number') continue;
            // Attempt to determine the maximum set of characters within comment body that can represent this 2dGram, then underline all those chars. To do this,
            // 1. Isolate the portion of the string that we know will not include any of this 2dGram using the wordRef.index
            // const bodyFirstHalf = comment.body.slice(0, startAtIndex);
            // const bodySecondHalf = comment.body.slice(startAtIndex); // now we only need to search bodySecondHalf for words to augment
            const commentBody = comment.body;

            // 2. Condense/reduce all of the rawWords, then find the indexes of the single tokens which occurs first, and last.
            const reducedRawWords = [...new Set(thisPointedWordRef.rawWords.join(' ').split(' '))];
            let maxPossibleLength = reducedRawWords.join(' ').length; // estimate a max length to help round out edges in our matching logic (like finding the wrong "not" when the correct occurance is inside "can't").
            if (typeof thisPointedWordRef.distance === 'number') maxPossibleLength = maxPossibleLength + thisPointedWordRef.distance;
            let firstIndex = null;
            let lastIndex = null;
            let lastIndexWord = null;
            const tokenIndexes = {}; // {token1: [2, 5], token2: [3], etc}
            reducedRawWords.forEach((thisRawWord) => {
                const foundAtIndexes = [...commentBody.matchAll(new RegExp(`(${tokenBoundaries}|^)${thisRawWord}(${tokenBoundaries}|$)`, 'g'))].map(a => {
                    let index = a.index + 1;
                    if (a.index === 0) index = a.index;
                    return index;
                }).sort((a, b) => a - b);
                tokenIndexes[thisRawWord] = foundAtIndexes;
                const lowestFoundAtIndex = tokenIndexes[thisRawWord][0];
                if (firstIndex === null || lowestFoundAtIndex < firstIndex) firstIndex = lowestFoundAtIndex;
            });
            reducedRawWords.forEach((thisRawWord) => {
                const lowestFoundAtIndex = tokenIndexes[thisRawWord][0]; // we always use the first occurance, even when searching for lastIndex. This is to keep the 2dGram illust as close to index as possible.
                if (lastIndex === null || (lowestFoundAtIndex > lastIndex && lowestFoundAtIndex - firstIndex <= maxPossibleLength)) {
                    lastIndex = lowestFoundAtIndex;
                    lastIndexWord = thisRawWord;
                }
            });
            // 3. Take our firstIndex and lastIndex to wrap that portion of comment.body in our style wrapper el.
            const spanned2dGramStr = commentBody.slice(firstIndex, lastIndex + lastIndexWord.length);

            let underlineOpacity = 0;
            if (typeof thisPointedWordRef.distance === 'number') {
                underlineOpacity = 0.6-(thisPointedWordRef.distance / spanned2dGramStr.length);
                if (underlineOpacity > 0) underlineOpacity = Math.max(underlineOpacity, .15); // if we don't set a min opacity we lose the viz in some cases
            }

            const leftBracketEl = `<span style="display: inline-block; height: 12px; margin-bottom: -1.22rem; margin-left: -4px; border-left: 4px solid rgba(255, 149, 151, ${underlineOpacity});"></span>`;
            const rightBracketEl = `<span style="display: inline-block; height: 12px; margin-bottom: -1.22rem; margin-right: -4px; border-right: 4px solid rgba(255, 149, 151, ${underlineOpacity});"></span>`;
            formattedBody = formattedBody +
                '<span style="position: absolute; top: 0; left: 0; width: 100%; color: rgba(0,0,0,0); z-index: -1;">' +
                commentBody.replace(spanned2dGramStr, `<span style="padding-bottom: 6px; border-bottom: 4px solid rgba(255, 149, 151, ${underlineOpacity}); position: relative;">${leftBracketEl}${spanned2dGramStr}${rightBracketEl}</span>`) +
                '</span>';
        };

        // 3. If body contains any symbols with assocs, inject the assoc now. i.e: emoji symbols should show as rendered instead of showing shortcode text.
        comment.symbols.forEach((thisSymbol) => {
            const thisSymbolAssocHtml = commentFormatter.getEmojiAssocHtml(thisSymbol);
            if (thisSymbolAssocHtml) formattedBody = formattedBody.replaceAll(thisSymbol.symbol, thisSymbolAssocHtml);
        });

        formattedBody = `${formattedBody}</div>`;
        return formattedBody;
    },

    getEmojiAssocHtml: (emojiSymbol) => {
        if (emojiSymbol.type !== 'emoji' || !emojiSymbol.assocs[0]) return; // For now, we always render the first assoc in the array. We don't currently have a use case for an emoji having more than one assoc
        const thisSymbolAssoc = emojiSymbol.assocs[0];
        let thisSymbolAssocHtml = '';
        if (thisSymbolAssoc.type === 'unicode') {
            thisSymbolAssocHtml = thisSymbolAssoc.assoc;
        }
        if (thisSymbolAssoc.type === 'image') {
            thisSymbolAssocHtml = `<span class="emoji emoji__32"><span style="background-image: url('${thisSymbolAssoc.assoc}')"></span></span>`;
        }
        return thisSymbolAssocHtml;
    },

    getRenderableSymbolName: (comment) => {
        if (!comment || !comment.topSymbolHigh) return '';
        let topSymbolName = '';
        if (comment.topSymbolHigh['1Hr']) {
            let wordTopSymbolObj;
            comment.symbols.forEach((thisSymbol) => {
                const thisSymbolKey = `symbol:${thisSymbol.type}:${thisSymbol.symbol}`;
                if (thisSymbolKey === comment.topSymbolHigh['1Hr']) wordTopSymbolObj = thisSymbol;
            });
            if (wordTopSymbolObj && wordTopSymbolObj.type !== 'emoji') {
                topSymbolName = wordTopSymbolObj.name;
                if (wordTopSymbolObj.funcdSymbolData) topSymbolName = wordTopSymbolObj.funcdSymbolData.name || topSymbolName;
            }
        }
        return topSymbolName;
    },

    getNumberOrdinal: (n) => {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

}; // end utils

export default commentFormatter;
