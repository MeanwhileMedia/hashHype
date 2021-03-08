import React from '/node_modules/react';
import AdminTrainRow from './TopTagNetworks-adminTrain-row.jsx'
import styles from './styles/TopTagNetworks-adminTrain.css';

import hbClientSocketDbRequests_admin from '../helpers/hbClientSocketDbRequests-admin.js';

class AdminTrain extends React.Component {
    constructor(props) {
        super(props);

        this.state = {
            accordionCollapsed: [] //list of accordion title names which were collapsed by ui click
        };
    }

    render() {
        const thisView = this;
        const css = styles.generate(this);

        let commentColumn = (
            <AdminTrainRow
                topTag={thisView.props.topTag}
                label={(<><p>{thisView.props.topTag.body}</p><div><p>({thisView.props.topTag.id})</p></div></>)}
                deletePrompt={(
                    <><p><i>Comment is not relevant?</i>
                        <button className="button_sev1" onClick={this.deleteComment.bind(this, this.props.topTag)}>Confirm</button>
                    </p></>
                )}
            />
        );
        if (this.state.accordionCollapsed.indexOf('Comment') !== -1) commentColumn = null;

        let usernameColumn = (
            <AdminTrainRow
                topTag={thisView.props.topTag}
                label={(<><p>{this.props.topTag.author.name}</p></>)}
                deletePrompt={(
                    <><p><i>User is not relevant?</i>
                        <button className="button_sev1" onClick={this.markUserNotRelevant.bind(this, this.props.topTag.author.name, this.props.topTag)}>Confirm</button>
                    </p></>
                )}
            />
        );
        if (this.state.accordionCollapsed.indexOf('Username') !== -1) usernameColumn = null;

        let wordColumns = [];
        const sortedWords = Object.entries(this.props.topTag.points['1Hr']).sort((a, b) => {
            return b[1] - a[1];
        });
        sortedWords.forEach((word) => {
            const rowLabel = (
                <><p>{word[0]} <b>({word[1]})</b></p></>
            );
            const deletePrompt = (
                <><p><i>Word is not relevant to:</i>
                    <button className="button_sev1" onClick={this.deleteWordFromComment.bind(this, word[0], this.props.topTag)}>Comment</button>
                    <button className="button_sev2" onClick={this.markWordNotRelevant.bind(this, word[0], this.props.topTag)}>All</button>
                </p></>
            );
            wordColumns.push((
                <AdminTrainRow
                    topTag={thisView.props.topTag}
                    label={rowLabel}
                    deletePrompt={deletePrompt}
                />
            ));
        });
        if (this.state.accordionCollapsed.indexOf('Words') !== -1) wordColumns = [];

        let symbolColumns = [];
        this.props.topTag.symbols.forEach((symbol) => {
            const rowLabel = (
                <><p>{symbol.name} <b>({symbol.symbol})</b></p></>
            );
            const deletePrompt = (
                <><p><i>Symbol is not relevant to comment?</i>
                    <button className="button_sev1" onClick={this.deleteSymbolFromComment.bind(this, symbol.symbol, this.props.topTag)}>Confirm</button>
                </p></>
            );
            symbolColumns.push((
                <AdminTrainRow
                    topTag={thisView.props.topTag}
                    label={rowLabel}
                    deletePrompt={deletePrompt}
                />
            ));
        });
        if (this.state.accordionCollapsed.indexOf('Symbols') !== -1) symbolColumns = [];

        return (
            <div className="adminTrain" style={css.adminTrain}>
                <div style={css.adminTrain_section}>
                    <div style={{position: 'relative'}}>
                        <h5 style={{cursor: 'ns-resize'}} onClick={this.toggleAccord.bind(this)}>Comment</h5>
                        <p style={{position: 'absolute', right: 0, top: '-10px'}}>Points: <b>{thisView.props.topTag.totalPoints['1Hr']}</b></p>
                    </div>
                    {commentColumn}
                </div>
                <div style={css.adminTrain_section}>
                    <h5 style={{cursor: 'ns-resize'}} onClick={this.toggleAccord.bind(this)}>Username</h5>
                    {usernameColumn}
                </div>
                <div style={css.adminTrain_section}>
                    <h5 style={{cursor: 'ns-resize'}} onClick={this.toggleAccord.bind(this)}>Words</h5>
                    {wordColumns}
                </div>
                <div style={css.adminTrain_section}>
                    <h5 style={{cursor: 'ns-resize'}} onClick={this.toggleAccord.bind(this)}>Symbols</h5>
                    {symbolColumns}
                </div>
        </div>
        );
    }

    toggleAccord(e) {
        const thisAccordTitle = e.currentTarget.innerHTML;
        const newCollapsedState = [...this.state.accordionCollapsed];
        const accordCollapsedIndex = newCollapsedState.indexOf(thisAccordTitle);
        if (accordCollapsedIndex === -1) {
            newCollapsedState.push(thisAccordTitle);
        } else {
            newCollapsedState.splice(accordCollapsedIndex, 1);
        }
        this.setState({
            accordionCollapsed: newCollapsedState
        });
    }

    markUserNotRelevant(username, comment) {
        // applies to all future comments, AND deletes this comment
        hbClientSocketDbRequests_admin.markUserNotRelevant({
            username: username //case sensitive string
        });
        hbClientSocketDbRequests_admin.deleteComment({ // We will also delete this comment since it was by our now not relevant user
            commentId: comment.id
        });
    }

    markWordNotRelevant(word, comment) {
        // applies to all future comments, AND to this comment
        hbClientSocketDbRequests_admin.markWordNotRelevant({
            word: word //a word combo in string format: 'buy_gme_now'
        });
        hbClientSocketDbRequests_admin.deleteWordFromComment({
            word: word, //a word combo in string format: 'buy_gme_now'
            commentId: comment.id
        });
    }

    deleteWordFromComment(word, comment) {
        // applies only to this comment
        hbClientSocketDbRequests_admin.deleteWordFromComment({
            word: word, //a word combo in string format: 'buy_gme_now'
            commentId: comment.id
        });
    }

    deleteSymbolFromComment(symbol, comment) {
        // applies only to this comment
        hbClientSocketDbRequests_admin.deleteSymbolFromComment({
            symbol: symbol, //string - this symbol.symbol prop of a symbol object
            commentId: comment.id
        });
    }

    deleteComment(comment) {
        // applies only to this comment
        hbClientSocketDbRequests_admin.deleteComment({
            commentId: comment.id
        });
    }

}

export default AdminTrain;
