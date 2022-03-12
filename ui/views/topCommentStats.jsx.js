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
            freezeState: false, // set to true and all calls to receiveNewState (from our server socket) will be discarded.
            comments: [], // all the comments received from server (stats:topComments) of all symbol types
            activeSymbolTypes: ['stock'], // ['coin', 'stock', etc]
            focusedTopComment: null,
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
        this.registerKeyboardCtrls();
    }

    receiveNewState(socketData) {
        if (this.state.freezeState) {
            // console.log('State is frozen...');
            return;
        }
        socketData.topCommentsLastUpdated = Date.now();
        this.setState(socketData);
    }

    registerKeyboardCtrls() {
        utils.registerKeyboardCtrlsListener('focusNextTopCommentRight', this.focusNextTopComment.bind(this), {
            keyCode: 39, // "ArrowRight"
            ctrlKey: false,
            shiftKey: false
        });
        utils.registerKeyboardCtrlsListener('focusNextTopCommentDown', this.focusNextTopComment.bind(this), {
            keyCode: 40, // "ArrowDown"
            ctrlKey: false,
            shiftKey: false
        });
        utils.registerKeyboardCtrlsListener('focusPrevTopCommentLeft', this.focusPrevTopComment.bind(this), {
            keyCode: 37, // "ArrowLeft"
            ctrlKey: false,
            shiftKey: false
        });
        utils.registerKeyboardCtrlsListener('focusPrevTopCommentUp', this.focusPrevTopComment.bind(this), {
            keyCode: 38, // "ArrowUp"
            ctrlKey: false,
            shiftKey: false
        });
    }

    addActiveSymbolType(type) {
        const newSymbolTypes = [...this.state.activeSymbolTypes];
        if (newSymbolTypes.indexOf(type) === -1) newSymbolTypes.push(type);
        this.setState({activeSymbolTypes: newSymbolTypes});
    }
    removeActiveSymbolType(type) {
        const newSymbolTypes = [...this.state.activeSymbolTypes];
        const existingSymbolTypeIndex = newSymbolTypes.indexOf(type);
        if (existingSymbolTypeIndex === -1) return;
        newSymbolTypes.splice(existingSymbolTypeIndex, 1);
        this.setState({activeSymbolTypes: newSymbolTypes});
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
    getTopCommentsVizType() {
        return this.state.topCommentsVizType;
    }

    getFilteredTopComments() {
        const self = this;
        let topComments = [];
        self.state.activeSymbolTypes.forEach((thisSymbolType) => {
            if (!self.state.comments[thisSymbolType]) return;
            topComments = topComments.concat(self.state.comments[thisSymbolType]);
        });
        return topComments;
    }

    createCommentVisEl(topComments) {
        let commentVisEl;
        if (!this.state.topCommentsVizType || this.state.topCommentsVizType === 'barRace') {
            commentVisEl = (
                <BarRace
                    topComments={topComments}
                    topCommentsLastUpdated={this.state.topCommentsLastUpdated}
                    focusTopComment={this.focusTopComment.bind(this)}
                    focusedTopComment={this.state.focusedTopComment}
                    toggleFreezeState={this.toggleFreezeState.bind(this)}
                    setPageIsReady={this.setPageIsReady.bind(this)}
                    gNav={this.gNavRef.current}
                    getTopCommentsVizType={this.getTopCommentsVizType.bind(this)}
                />
            );
        } else {
            commentVisEl = (
                <SpinWheel
                    topComments={topComments}
                    topCommentsLastUpdated={this.state.topCommentsLastUpdated}
                    focusTopComment={throttleDebounce.throttle(200, this.focusTopComment).bind(this)}
                    focusedTopComment={this.state.focusedTopComment}
                    toggleFreezeState={this.toggleFreezeState.bind(this)}
                    setPageIsReady={this.setPageIsReady.bind(this)}
                    gNav={this.gNavRef.current}
                    getTopCommentsVizType={this.getTopCommentsVizType.bind(this)}
                />
            );
        }
        return commentVisEl;
    }

    render() {
        const thisView = this;
        const css = styles.generate(this);
        const StyleRoot = Radium.StyleRoot;

        const topComments = this.getFilteredTopComments();
        const commentVisEl = this.createCommentVisEl(topComments);

        let loadSpinnerEl = null;
        if (!this.state.pageIsReady) {
            loadSpinnerEl = (
                <div class="loadSpinner_wrapper"><div class="loadSpinner__ring"><div></div><div></div><div></div><div></div></div></div>
            );
        }

        return (
            <StyleRoot>
                <div className="topCommentStats" style={css.topCommentStats}>
                    {commentVisEl}
                </div>
                {loadSpinnerEl}
                <Modal content={this.state.modalContent} modal={this.modalControls} />
                <GNav
                    ref={this.gNavRef}
                    topComments={topComments}
                    modal={this.modalControls}
                    setTopCommentsVizType={this.setTopCommentsVizType.bind(this)}
                    addActiveSymbolType={this.addActiveSymbolType.bind(this)}
                    removeActiveSymbolType={this.removeActiveSymbolType.bind(this)}
                    activeSymbolTypes={this.state.activeSymbolTypes}
                    topCommentsVizType={this.state.topCommentsVizType}
                    focusedTopComment={this.state.focusedTopComment}
                />
            </StyleRoot>
        );
    }

    setPageIsReady(isReady = true) {
        this.setState({pageIsReady: isReady});
    }

    focusTopComment(comment) {
        if (!comment) return;
        this.setState({ focusedTopComment: comment });
    }
    focusNextTopComment() {
        const self = this;
        if (!this.state.focusedTopComment) return;
        const topComments = self.getFilteredTopComments();
        const curRank = this.state.focusedTopComment.rankRender;
        let nextTopComment = topComments.find(thisTopComment => thisTopComment.rankRender === curRank + 1);
        if (!nextTopComment) nextTopComment = topComments.find(thisTopComment => thisTopComment.rankRender === 1);
        setTimeout(() => self.focusTopComment(nextTopComment), 0); // when passing functions into input event listeners (keyboard controls) should wait until next tick so all registered events have time to process.
    }
    focusPrevTopComment() {
        const self = this;
        if (!self.state.focusedTopComment) return;
        const topComments = self.getFilteredTopComments();
        const curRank = self.state.focusedTopComment.rankRender;
        const targetRank = curRank - 1;
        let prevTopComment;
        if (targetRank < 1) {
            topComments.forEach(thisTopComment => { if (thisTopComment.rankRender > targetRank) prevTopComment = thisTopComment });
        } else {
            prevTopComment = topComments.find(thisTopComment => thisTopComment.rankRender === targetRank);
        }
        setTimeout(() => self.focusTopComment(prevTopComment), 0);
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
