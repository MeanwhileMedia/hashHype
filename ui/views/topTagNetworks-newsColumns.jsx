import React from '/node_modules/react';
import _ from '/node_modules/underscore';
import AdminTrain from './topTagNetworks-adminTrain.jsx'
import styles from './styles/topTagNetworks-newsColumns.css';

class TopTagnewsColumns extends React.Component {
    render() {
        if (_.size(this.props.topTags) === 0) { return null; }
        const thisView = this;
        const css = styles.generate(this);

        thisView.activeTopTag = _.find(this.props.topTags, topTag => topTag.isFocused);
        if (!thisView.activeTopTag) { return null; }

        let topSymbolName = '';
        if (thisView.activeTopTag.topSymbol) {
            let topSymbolNameText = thisView.activeTopTag.topSymbol.name;
            if (thisView.activeTopTag.topSymbol.funcdSymbolData) topSymbolNameText = thisView.activeTopTag.topSymbol.funcdSymbolData.name || topSymbolNameText;
            topSymbolName = (
                <>
                    <h2>{topSymbolNameText}</h2>
                </>
            );
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
                <div style={css.newsColumns_ctrls}>
                    <div style={css.newsColumns_ctrls_adminModal} onClick={this.showAdminCtrlsModal.bind(this)}>
                        <span class="material-icons">settings</span>
                    </div>
                </div>
            </div>
        );
    } // end render

    showAdminCtrlsModal() {
        const trainingUi = (
            <AdminTrain topTag={this.activeTopTag} hideModal={this.hideAdminCtrlsModal.bind(this)}/>
        );
        this.props.modal.show({
            title: 'Relevancy Training',
            body: trainingUi
        });
    }
    hideAdminCtrlsModal() {
        this.props.modal.hide();
    }
}

export default TopTagnewsColumns;
