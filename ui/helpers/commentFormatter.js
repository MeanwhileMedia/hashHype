// Functions to prep comment data for rendering
const commentFormatter = {

    formatCommentBody: (comment) => { // returns HTML string
        if (!comment || !comment.body) return '';
        let formattedBody = comment.body;

        // 1. We will bold any inline text which earned points for this comment. We do this by using the
        // SHORTEST raw word sequence which belongs to each of our comment.points words.
        const boldTheseWordSeqs = [];
        for (let [wordStr, pointsForWord] of Object.entries(comment.points['1Hr'])) {
            let shortestRawSequenceStr = '';
            let shortestRawSequenceTokenCount = null;
            const thisPointedWordRef = comment.words.find(thisWordRef => thisWordRef.word === wordStr);
            thisPointedWordRef.rawWords.forEach((thisRawWordSeqStr) => {
                const thisRawWordSeqTokenCount = thisRawWordSeqStr.split(' ').length;
                if (shortestRawSequenceTokenCount === null || thisRawWordSeqTokenCount < shortestRawSequenceTokenCount) {
                    shortestRawSequenceStr = thisRawWordSeqStr;
                    shortestRawSequenceTokenCount = thisRawWordSeqTokenCount;
                }
            });
            if (boldTheseWordSeqs.indexOf(shortestRawSequenceStr) === -1) boldTheseWordSeqs.push(shortestRawSequenceStr);
        };
        boldTheseWordSeqs.forEach((thisRawWordSeqStr) => {
            formattedBody = formattedBody.replace(thisRawWordSeqStr, `<strong>${thisRawWordSeqStr}</strong>`);
        });

        // 2. If body contains any symbols with assocs, inject the assoc now. i.e: emoji symbols should show as rendered instead of showing shortcode text.
        comment.symbols.forEach((thisSymbol) => {
            const thisSymbolAssocHtml = commentFormatter.getEmojiAssocHtml(thisSymbol);
            if (thisSymbolAssocHtml) formattedBody = formattedBody.replaceAll(thisSymbol.symbol, thisSymbolAssocHtml);
        });

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
        if (comment.topSymbolHigh['1Hr'].key) {
            let wordTopSymbolObj;
            comment.symbols.forEach((thisSymbol) => {
                const thisSymbolKey = `symbol:${thisSymbol.type}:${thisSymbol.symbol}`;
                if (thisSymbolKey === comment.topSymbolHigh['1Hr'].key) wordTopSymbolObj = thisSymbol;
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
