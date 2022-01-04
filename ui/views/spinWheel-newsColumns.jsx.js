import React from '/node_modules/react';
import TopCommentBodyAndPoints from './topCommentBodyAndPoints.jsx.js'
import commentFormatter from '../helpers/commentFormatter.js'
import styles from './styles/spinWheel-newsColumns.css.js';

class SpinWheelNewsColumns extends React.Component {

    render() {
        if (!this.props.topComments || this.props.topComments.length === 0) { return null; }
        const thisView = this;
        const css = styles.generate(this);

        if (!thisView.props.focusedTopComment) { return null; }

        const topSymbolName = (
            <>
                <h2>{commentFormatter.getRenderableSymbolName(thisView.props.focusedTopComment)}</h2>
            </>
        );

        let commentAuthorAndPoints = '';
        if (thisView.props.focusedTopComment.author && thisView.props.focusedTopComment.author.name) {
            commentAuthorAndPoints = (
                <div className="spinWheel_newsColumns_left_author">
                    <h2>@{thisView.props.focusedTopComment.author.name}</h2>
                </div>
            );
        }

        const showComment = (
            <>
                <TopCommentBodyAndPoints topComment={thisView.props.focusedTopComment}/>
            </>
        );

        const leftColumn = topSymbolName || commentAuthorAndPoints || '';
        const rightColumn = showComment || '';

        return (
            <div className="spinWheel_newsColumns" style={css.newsColumns}>
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

export default SpinWheelNewsColumns;
