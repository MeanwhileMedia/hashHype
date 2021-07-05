import React from '/node_modules/react';
import styles from './styles/topTagNetworks-newsColumns.css.js';

class TopTagnewsColumns extends React.Component {
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
                    <h4 style={css.newsColumns_left_author_h4}>Comment Points: <b>{thisView.activeTopTag.totalPoints['1Hr'].toLocaleString()}</b></h4>
                </div>
            );
        }

        const showComment = (
            <>
                <h4>
                    {thisView.activeTopTag.body}
                    {topSymbolName &&
                        <div style={{fontWeight: 400}}>@{thisView.activeTopTag.author.name || ''}</div>
                    }
                </h4>
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
