// Functions to prep comment data for rendering
const commentFormatter = {

    getEmojiAssocHtml: (emojiSymbol) => {
        if (emojiSymbol.type !== 'emoji' || !emojiSymbol.assocs[0]) return; // For now, we always render the first assoc in the array. We don't currently have a use case for an emoji having more than one assoc
        const thisSymbolAssoc = emojiSymbol.assocs[0];
        let thisSymbolAssocHtml = '';
        if (thisSymbolAssoc.type === 'unicode') {
            thisSymbolAssocHtml = `<span class="emoji">${thisSymbolAssoc.assoc}</span>`;
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
                if (thisSymbol.key === comment.topSymbolHigh['1Hr']) wordTopSymbolObj = thisSymbol;
            });
            if (wordTopSymbolObj && wordTopSymbolObj.type !== 'emoji') {
                topSymbolName = wordTopSymbolObj.prettyName || wordTopSymbolObj.name;
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
