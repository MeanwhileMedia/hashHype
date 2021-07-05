import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import d3 from '/node_modules/d3';
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
import GNav from './gNav.jsx';
import TopTagWheel from './topTagNetworks-wheel.jsx';
import TopTagnewsColumns from './topTagNetworks-newsColumns.jsx';
import Modal from './modal.jsx';
import styles from './styles/topTagNetworks.css.js';

class TopTagNetworks extends React.Component {
    // ////////
    // React lifecycle functions
    constructor(props) {
        super(props);

        this.state = {
            focusedTopTag: null,
            freezeState: false, // set to true and all calls to receiveNewState (from our server socket) will be discarded.
            timeBuckets: {
                '1Hr': [],
                '12Hr': [],
                '24Hr': [],
                // 'all': []
            },
            modalContent: {
                title: '',
                body: '',
                visible: false,
                customStyleClasses: []
            },
        }

        this.modalControls = this.initModalControls();
    }

    componentDidMount() {
        const wheelAbsKey = 'stats:topComments';
        socketViewResponses.initViewChangeListener(wheelAbsKey, this);
    }

    receiveNewState(socketData) {
        if (this.state.freezeState) {
            // console.log('State is frozen...');
            return;
        }
        this.setState(socketData);
    }

    render() {
        const thisView = this;
        const css = styles.generate(this);
        const StyleRoot = Radium.StyleRoot;

        // Note which topTag wheel part is currently focused on the topTag itself (within state.topTagStats)
        this.state.timeBuckets['1Hr'].find((topTag, key) => {
            topTag.id === thisView.state.focusedTopTag ? topTag.isFocused = true : topTag.isFocused = false;
            return topTag.isFocused; // break loop
        });

        return (
            <StyleRoot>
                <div className="topTags" style={css.topTags}>
                    <TopTagWheel
                        topTags={this.state.timeBuckets['1Hr']}
                        focusTopTag={this.focusTopTag.bind(this)}
                        toggleFreezeState={this.toggleFreezeState.bind(this)}
                    />
                    <TopTagnewsColumns
                        topTags={this.state.timeBuckets['1Hr']}
                        modal={this.modalControls}
                    />
                </div>
                <Modal content={this.state.modalContent} modal={this.modalControls} />
                <GNav
                    topTags={this.state.timeBuckets['1Hr']}
                    modal={this.modalControls}
                />
            </StyleRoot>
        );
    }

    focusTopTag(id) {
        // The wheel was rotated and a new topTag has come into view.
        this.setState({ focusedTopTag: id });
    }

    toggleFreezeState(frozen) {
        if (typeof frozen !== 'boolean') frozen = !this.state.freezeState;
        this.setState({ freezeState: frozen });
    }

    initModalControls() {
        const thisView = this;
        const modalControls = {
            show: (opts) => {
                thisView.showModal.apply(thisView, [opts]);
                if (modalControls.onShowCbacks) modalControls.onShowCbacks.forEach(thisCback => thisCback());
            },
            hide: () => {
                thisView.hideModal.apply(thisView, arguments);
                if (modalControls.onHideCbacks) modalControls.onHideCbacks.forEach(thisCback => thisCback());
            },
            onHide: (thisOnHideCback) => {
                modalControls.onHideCbacks = modalControls.onHideCbacks || [];
                modalControls.onHideCbacks.push(thisOnHideCback);
            },
            onShow: (thisOnShowCback) => {
                modalControls.onShowCbacks = modalControls.onShowCbacks || [];
                modalControls.onShowCbacks.push(thisOnShowCback);
            }
        };
        return modalControls;
    }

    showModal(modalContent) {
        modalContent = Object.assign({
            title: '',
            body: '',
            visible: true,
            customStyleClasses: []
        }, modalContent);
        this.setState({ modalContent: modalContent });
    }

    hideModal() {
        this.setState({
            modalContent: {
                title: '',
                body: '',
                visible: false,
                customStyleClasses: []
            },
        });
    }

} // end view

export default TopTagNetworks;
