import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import d3 from '/node_modules/d3';
import throttleDebounce from '/node_modules/throttle-debounce';
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
import utils from '../helpers/utils.js'
import GNav from './gNav.jsx.js';
import TopTagWheel from './topTagNetworks-wheel.jsx.js';
import TopTagnewsColumns from './topTagNetworks-newsColumns.jsx.js';
import Modal from './modal.jsx.js';
import styles from './styles/topTagNetworks.css.js';

class TopTagNetworks extends React.Component {
    // ////////
    // React lifecycle functions
    constructor(props) {
        super(props);

        this.state = {
            pageIsReady: false, // all page content will have 0 opacity until this is set to true
            focusedTopTag: null,
            freezeState: false, // set to true and all calls to receiveNewState (from our server socket) will be discarded.
            comments: [],
            topTagsLastUpdated: Date.now(), // when was the last time we got a fresh stats:topComments from the server
            modalContent: {
                title: '',
                body: '',
                visible: false,
                customStyleClasses: []
            },
        }

        this.modalControls = this.initModalControls();
        this.gNavRef = React.createRef();
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
        socketData.topTagsLastUpdated = Date.now();
        this.setState(socketData);
    }

    render() {
        const thisView = this;
        const css = styles.generate(this);
        const StyleRoot = Radium.StyleRoot;

        // Note which topTag wheel part is currently focused on the topTag itself (within state.topTagStats)
        this.state.comments.forEach((topTag, key) => {
            topTag.id === thisView.state.focusedTopTag ? topTag.isFocused = true : topTag.isFocused = false;
        });

        return (
            <StyleRoot>
                <div className="topTags" style={css.topTags}>
                    <TopTagWheel
                        topTags={this.state.comments}
                        topTagsLastUpdated={this.state.topTagsLastUpdated}
                        focusTopTag={throttleDebounce.throttle(200, this.focusTopTag).bind(this)}
                        toggleFreezeState={this.toggleFreezeState.bind(this)}
                        setPageIsReady={this.setPageIsReady.bind(this)}
                        gNav={this.gNavRef.current}
                    />
                    <TopTagnewsColumns
                        topTags={this.state.comments}
                        modal={this.modalControls}
                    />
                </div>
                <Modal content={this.state.modalContent} modal={this.modalControls} />
                <GNav
                    ref={this.gNavRef}
                    topTags={this.state.comments}
                    modal={this.modalControls}
                />
            </StyleRoot>
        );
    }

    setPageIsReady() {
        this.setState({pageIsReady: true});
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
            },
            isShown: false
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
        this.modalControls.isShown = true;
        this.setState({ modalContent: modalContent });
        document.querySelector('body').classList.add('modalOpen');
    }

    hideModal() {
        this.modalControls.isShown = false;
        this.setState({
            modalContent: {
                title: '',
                body: '',
                visible: false,
                customStyleClasses: []
            },
        });
        document.querySelector('body').classList.remove('modalOpen');
    }

} // end view

export default TopTagNetworks;
