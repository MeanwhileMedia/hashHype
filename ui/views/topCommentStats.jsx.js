import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import throttleDebounce from '/node_modules/throttle-debounce';
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
import utils from '../helpers/utils.js'
import GNav from './gNav.jsx.js';
import Modal from './modal.jsx.js';
import BarRace from './barRace.jsx.js';
let SpinWheel; // lazy loaded
let spinWheelPath = './spinWheel.jsx.js';

import styles from './styles/topCommentStats.css.js';

class TopCommentStats extends React.Component {
    // ////////
    // React lifecycle functions
    constructor(props) {
        super(props);

        this.state = {
            pageIsReady: false, // all page content will have 0 opacity until this is set to true
            focusedTopComments: null,
            freezeState: false, // set to true and all calls to receiveNewState (from our server socket) will be discarded.
            comments: [],
            topCommentsLastUpdated: Date.now(), // when was the last time we got a fresh stats:topComments from the server
            topCommentsVizType: 'barRace', // barRace or spinWheel
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
        socketData.topCommentsLastUpdated = Date.now();
        this.setState(socketData);
    }

    setTopCommentsVizType(type = 'barRace') { // 'barRace', 'spinWheel', or 'toggle'
        if (type === 'toggle') {
            type = 'spinWheel';
            if (this.state.topCommentsVizType === 'spinWheel') type = 'barRace';
        }
        if (this.state.topCommentsVizType !== type) this.setPageIsReady(false);
        if (type === 'spinWheel') {
            if (!SpinWheel) { // spinWheel is not the default landing viz and is lazy loaded
                import(spinWheelPath).then((asyncModule) => {
                    SpinWheel = asyncModule.default;
                    this.setState({topCommentsVizType: type});
                });
            } else {
                this.setState({topCommentsVizType: type});
            }
        } else {
            this.setState({topCommentsVizType: type});
        }
    }

    createCommentVisEl() {
        let commentVisEl;
        if (!this.state.topCommentsVizType || this.state.topCommentsVizType === 'barRace') {
            commentVisEl = (
                <BarRace
                    topComments={this.state.comments}
                    topCommentsLastUpdated={this.state.topCommentsLastUpdated}
                    focusTopComment={throttleDebounce.throttle(200, this.focusTopComment).bind(this)}
                    focusedTopComment={this.state.focusedTopComment}
                    toggleFreezeState={this.toggleFreezeState.bind(this)}
                    setPageIsReady={this.setPageIsReady.bind(this)}
                    gNav={this.gNavRef.current}
                />
            );
        } else {
            commentVisEl = (
                <SpinWheel
                    topComments={this.state.comments}
                    topCommentsLastUpdated={this.state.topCommentsLastUpdated}
                    focusTopComment={throttleDebounce.throttle(200, this.focusTopComment).bind(this)}
                    focusedTopComment={this.state.focusedTopComment}
                    toggleFreezeState={this.toggleFreezeState.bind(this)}
                    setPageIsReady={this.setPageIsReady.bind(this)}
                    gNav={this.gNavRef.current}
                />
            );
        }
        return commentVisEl;
    }

    render() {
        const thisView = this;
        const css = styles.generate(this);
        const StyleRoot = Radium.StyleRoot;

        this.state.comments.forEach((topComment, key) => {
            topComment.id === thisView.state.focusedTopComment ? topComment.isFocused = true : topComment.isFocused = false;
        });

        const commentVisEl = this.createCommentVisEl();
        return (
            <StyleRoot>
                <div className="topCommentStats" style={css.topCommentStats}>
                    {commentVisEl}
                </div>
                <Modal content={this.state.modalContent} modal={this.modalControls} />
                <GNav
                    ref={this.gNavRef}
                    topComments={this.state.comments}
                    modal={this.modalControls}
                    setTopCommentsVizType={this.setTopCommentsVizType.bind(this)}
                />
            </StyleRoot>
        );
    }

    setPageIsReady(isReady = true) {
        this.setState({pageIsReady: isReady});
    }

    focusTopComment(id) {
        this.setState({ focusedTopComment: id });
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

export default TopCommentStats;
