import React from '/node_modules/react';
import highlight from '/node_modules/highlight';
import highlightJs from '/node_modules/highlight/js';
import highlightJsStyles from '/node_modules/highlight/jsStyles.css';
highlight.registerLanguage('javascript', highlightJs);

import AdminTrainRow from './topTagNetworks-adminTrain-row.jsx'
import styles from './styles/topTagNetworks-adminTrain.css.js';

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

        let commentSection = (
            <AdminTrainRow
                topTag={thisView.props.topTag}
                label={(<><p>{thisView.props.topTag.body}</p><div><p>({thisView.props.topTag.id})</p></div></>)}
                editIcon={'dangerous'}
                deletePrompt={(
                    <><p><i>Comment is not relevant?</i>
                        <button className="button_sev1" onClick={this.deleteComment.bind(this, this.props.topTag)}>Confirm</button>
                    </p></>
                )}
            />
        );
        if (this.state.accordionCollapsed.indexOf('Comment') !== -1) commentSection = null;

        let usernameSection = (
            <AdminTrainRow
                topTag={thisView.props.topTag}
                label={(<><p>{this.props.topTag.author.name}</p></>)}
                editIcon={'dangerous'}
                deletePrompt={(
                    <><p><i>User is not relevant?</i>
                        <button className="button_sev1" onClick={this.markUserNotRelevant.bind(this, this.props.topTag.author.name, this.props.topTag)}>Confirm</button>
                    </p></>
                )}
            />
        );
        if (this.state.accordionCollapsed.indexOf('Username') !== -1) usernameSection = null;

        let wordsSection = [];
        const sortedWords = Object.entries(this.props.topTag.points['1Hr']).sort((a, b) => {
            return b[1] - a[1];
        });
        sortedWords.forEach((word) => {
            const rowRef = React.createRef();
            const rowLabel = (
                <><p>{word[0].replace(/_!!_/g, ' ')} <b>({word[1]})</b></p></>
            );
            const deletePrompt = (
                <><p><i>Word is not relevant to:</i>
                    <button className="button_sev1" onClick={this.deleteWordFromComment.bind(this, word[0], this.props.topTag, rowRef)}>Comment</button>
                    <button className="button_sev2" onClick={this.markWordNotRelevant.bind(this, word[0], this.props.topTag, rowRef)}>All</button>
                </p></>
            );
            wordsSection.push((
                <AdminTrainRow
                    topTag={thisView.props.topTag}
                    label={rowLabel}
                    editIcon={'dangerous'}
                    deletePrompt={deletePrompt}
                    ref={rowRef}
                />
            ));
        });
        if (this.state.accordionCollapsed.indexOf('Words') !== -1) wordsSection = [];

        let symbolsSection = [];
        this.props.topTag.symbols.forEach((symbol) => {
            const rowRef = React.createRef();
            let symbolSymbolText = symbol.symbol.toUpperCase();
            if (symbolSymbolText.indexOf('HTTP') !== -1) {
                symbolSymbolText = (
                    <a href={symbol.symbol}>Link</a>
                );
            }
            const rowLabel = (
                <><p>{symbol.name} <b>({symbolSymbolText})</b></p></>
            );
            const deletePrompt = (
                <>
                    <p><i>Customize function:</i>
                        <button className="editFuncButton button_sev1" onClick={ (e) => { thisView.initSymbolCodeEdit.call(thisView, e, symbol, 'get', rowRef) } }>get ( )</button>
                        <button className="editFuncButton button_sev1" onClick={ (e) => { thisView.initSymbolCodeEdit.call(thisView, e, symbol, 'match', rowRef) } }>match ( )</button>
                    </p>
                    <div className="adminTrain_section_code" style={css.adminTrain_section_code}>
                        <pre>
                            <code className="adminTrain_section_code_presentation" style={css.adminTrain_section_code_presentation}></code>
                            <code className="adminTrain_section_code_input" style={css.adminTrain_section_code_input} contenteditable="true"></code>
                        </pre>
                        <div style={css.adminTrain_section_code_buttons}>
                            <button onClick={thisView.exitSymbolFunctionEdit.bind(thisView, 'cancel')}>Cancel</button>
                            <button className="button_sev2" onClick={this.exitSymbolFunctionEdit.bind(this, 'save')}>Save</button>
                        </div>
                    </div>
                </>
            );
            symbolsSection.push((
                <AdminTrainRow
                    topTag={thisView.props.topTag}
                    label={rowLabel}
                    editIcon={'article'}
                    deletePrompt={deletePrompt}
                    ref={rowRef}
                />
            ));
        });
        if (this.state.accordionCollapsed.indexOf('Symbols') !== -1) symbolsSection = [];

        return (
            <div className="adminTrain" style={css.adminTrain}>
                <div style={css.adminTrain_section}>
                    <div style={{position: 'relative'}}>
                        <h6 style={{cursor: 'ns-resize'}} onClick={this.toggleAccord.bind(this)}>Comment</h6>
                        <p style={{position: 'absolute', right: 0, top: '-1.2rem'}}>Points: <b>{thisView.props.topTag.totalPoints['1Hr']}</b></p>
                    </div>
                    {commentSection}
                </div>
                <div style={css.adminTrain_section}>
                    <h6 style={{cursor: 'ns-resize'}} onClick={this.toggleAccord.bind(this)}>Username</h6>
                    {usernameSection}
                </div>
                <div style={css.adminTrain_section}>
                    <h6 style={{cursor: 'ns-resize'}} onClick={this.toggleAccord.bind(this)}>Symbols</h6>
                    {symbolsSection}
                </div>
                <div style={css.adminTrain_section}>
                    <h6 style={{cursor: 'ns-resize'}} onClick={this.toggleAccord.bind(this)}>Words</h6>
                    {wordsSection}
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
            username: username, // case sensitive string
            commentId: comment.id // the comment for which this user was marked not relevant (optional)
        });
        this.props.hideModal();
    }

    markWordNotRelevant(word, comment, adminTrainRowRef) {
        // applies to all future comments, AND to this comment
        hbClientSocketDbRequests_admin.markWordNotRelevant({
            word: word, //a word combo in string format: 'buy_gme_now'
            commentId: comment.id
        });
        adminTrainRowRef.current.hideDeletePrompt();
    }

    deleteWordFromComment(word, comment, adminTrainRowRef) {
        // applies only to this comment
        hbClientSocketDbRequests_admin.deleteWordFromComment({
            word: word, //a word combo in string format: 'buy_gme_now'
            commentId: comment.id
        });
        adminTrainRowRef.current.hideDeletePrompt();
    }

    deleteComment(comment) {
        // applies only to this comment
        hbClientSocketDbRequests_admin.deleteComment({
            commentId: comment.id
        });
        this.props.hideModal();
    }

    exitSymbolFunctionEdit(action) { // action is 'save' or 'cancel'
        if (!this.currentlyEditingSymbol) return;
        if (action === 'cancel') {
            this.currentlyEditingSymbol.onExitEdit();
            return;
        }
        hbClientSocketDbRequests_admin.editSymbolFunction({
            symbol: this.currentlyEditingSymbol.symbol, //a full symbol object
            functionName: this.currentlyEditingSymbol.editingFunctionName,
            functionString: this.currentlyEditingSymbol.getEditedFunctionString()
        });
        this.currentlyEditingSymbol.onExitEdit();
    }

    initSymbolCodeEdit(e, symbol, editingFunctionName, adminTrainRowRef) {
        // Make some UI changes
        const self = this;
        const thisRowEl = e.target.closest('.adminTrain_section_rows');
        const editIcon = thisRowEl.querySelector('.adminTrain_section_rows_editIcon');
        const codeEditorWrapper = thisRowEl.querySelector('.adminTrain_section_code');
        const codeEditorInput = codeEditorWrapper.querySelector('.adminTrain_section_code_input');
        const codeEditorPresentation = codeEditorWrapper.querySelector('.adminTrain_section_code_presentation');
        codeEditorWrapper.style.display = 'block';
        editIcon.style.display = 'none';
        thisRowEl.querySelectorAll('.editFuncButton').forEach((b) => {
            b.style.opacity = .2;
            b.style.pointerEvents = 'none';
        });
        e.target.style.opacity = .5;
        document.querySelector('.adminTrain').addEventListener('click', (e) => {
            if (e.target.closest('.admintrain_section_rows_editicon')) self.currentlyEditingSymbol.onExitEdit(); // exit code editor if any other row is selected for editing
        });
        codeEditorInput.innerText = symbol[editingFunctionName];
        const presentCodeInput = () => {
            codeEditorPresentation.innerText = codeEditorInput.innerText;
            highlight.highlightElement(codeEditorPresentation);
        };
        presentCodeInput();
        codeEditorInput.addEventListener('keydown', presentCodeInput);
        codeEditorInput.addEventListener('input', presentCodeInput);
        // Save a local ref to be used in exitSymbolFunctionEdit
        this.currentlyEditingSymbol = {
            symbol: symbol,
            editingFunctionName: editingFunctionName,
            getEditedFunctionString: () => {
                return codeEditorInput.innerText;
            },
            onExitEdit: () => { // save or cancel
                adminTrainRowRef.current.hideDeletePrompt();
                codeEditorWrapper.style.display = 'none';
                editIcon.style.display = 'block';
                thisRowEl.querySelectorAll('.editFuncButton').forEach((b) => {
                    b.style.opacity = 1;
                    b.style.pointerEvents = 'all';
                });
                editIcon.click();
            }
        };
    }

}

export default AdminTrain;
