import React from '/node_modules/react';
import styles from './styles/topTagNetworks-newsColumns.css.js';

class TopTagnewsColumns extends React.Component {

    formatCommentBody(comment) {
        const self = this;
        const css = styles.generate(this);
        let formattedBody = comment.body;

        // 1. We will bold any inline text which earned points for this comment. We do this by using the
        // SHORTEST raw word sequence which belongs to each of our comment.points words.
        const boldTheseWordSeqs = [];
        for (let [wordStr, pointsForWord] of Object.entries(comment.points['1Hr'])) {
            let shortestRawSequence = [];
            const thisWordRef = comment.words.find(thisWordRef => thisWordRef.word === wordStr);
            thisWordRef.rawWords.forEach((thisRawWordSeq) => {
                if (!shortestRawSequence.length || (thisRawWordSeq.length < shortestRawSequence.length)) shortestRawSequence = thisRawWordSeq;
            });
            const rawSeqString = shortestRawSequence.join(' ');
            if (boldTheseWordSeqs.indexOf(rawSeqString) === -1) boldTheseWordSeqs.push(rawSeqString);
        };
        boldTheseWordSeqs.forEach((thisRawWordSeqStr) => {
            formattedBody = formattedBody.replace(thisRawWordSeqStr, `<strong>${thisRawWordSeqStr}</strong>`);
        });

        // 2. If body contains any symbols with assocs, inject the assoc now. i.e: emoji symbols should show as rendered instead of showing shortcode text.
        comment.symbols.forEach((thisSymbol) => {
            const thisSymbolAssocHtml = self.getEmojiAssocHtml(thisSymbol);
            if (thisSymbolAssocHtml) formattedBody = formattedBody.replaceAll(thisSymbol.symbol, thisSymbolAssocHtml);
        });

        return (<span style={css.newsColumns_right_body} dangerouslySetInnerHTML={{ __html: formattedBody }} />);
    }

    getEmojiAssocHtml(emojiSymbol) {
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
    }

    render() {
        if (this.props.topTags.length === 0) { return null; }
        const thisView = this;
        const css = styles.generate(this);

        thisView.activeTopTag = this.props.topTags.find(topTag => topTag.isFocused);
        if (!thisView.activeTopTag) { return null; }

        let topSymbolName = '';
        if (thisView.activeTopTag.topSymbolHigh['1Hr'].key) {
            let wordTopSymbolObj;
            thisView.activeTopTag.symbols.forEach((thisSymbol) => {
                const thisSymbolKey = `symbol:${thisSymbol.type}:${thisSymbol.symbol}`;
                if (thisSymbolKey === thisView.activeTopTag.topSymbolHigh['1Hr'].key) wordTopSymbolObj = thisSymbol;
            });
            if (wordTopSymbolObj && wordTopSymbolObj.type !== 'emoji') {
                let topSymbolNameText = wordTopSymbolObj.name;
                if (wordTopSymbolObj.funcdSymbolData) topSymbolNameText = wordTopSymbolObj.funcdSymbolData.name || topSymbolNameText;
                topSymbolName = (
                    <>
                        <h2>{topSymbolNameText}</h2>
                    </>
                );
            }
        }

        let commentAuthorAndPoints = '';
        if (thisView.activeTopTag.author && thisView.activeTopTag.author.name) {
            commentAuthorAndPoints = (
                <div className="topTagNetworks_newsColumns_left_author">
                    <h2>@{thisView.activeTopTag.author.name}</h2>
                </div>
            );
        }

        const formattedCommentBody = this.formatCommentBody(thisView.activeTopTag);
        const showComment = (
            <>
                <h5>
                    {formattedCommentBody}
                    {topSymbolName &&
                        <div><span style={css.newsColumns_right_author}>@{thisView.activeTopTag.author.name || ''}</span></div>
                    }
                </h5>
            </>
        );

        const leftColumn = topSymbolName || commentAuthorAndPoints || '';
        const rightColumn = showComment || '';

        return (
            <div className="topTagNetworks_newsColumns" style={css.newsColumns}>
                <div style={css.newsColumns_left}>
                    {leftColumn}
                </div>
                <div style={css.newsColumns_right}>
                    {rightColumn}
                </div>
            </div>
        );
    } // end render

}

export default TopTagnewsColumns;
