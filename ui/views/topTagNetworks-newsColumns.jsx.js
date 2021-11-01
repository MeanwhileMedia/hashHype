import React from '/node_modules/react';
import styles from './styles/topTagNetworks-newsColumns.css.js';

class TopTagnewsColumns extends React.Component {

    formatCommentBody(comment) {
        const css = styles.generate(this);
        let formattedBody = comment.body;
        // We will bold any inline text which earned points for this comment. We do this by using the
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
        return (<span style={css.newsColumns_right_body} dangerouslySetInnerHTML={{ __html: formattedBody }} />);
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
            if (wordTopSymbolObj) {
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
