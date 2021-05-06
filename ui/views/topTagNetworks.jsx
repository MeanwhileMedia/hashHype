import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import d3 from '/node_modules/d3';
import _ from '/node_modules/underscore';
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
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
                '1hr': [],
                '12Hr': [],
                '24Hr': [],
                // 'all': []
            },
            modalContent: {
                title: '',
                body: '',
                visible: false,
            },
        }
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
        const modalControls = { show: thisView.showModal.bind(thisView), hide: thisView.hideModal.bind(thisView) };

        // Note which topTag wheel part is currently focused on the topTag itself (within state.topTagStats)
        _.find(this.state.timeBuckets['1Hr'], (topTag, key) => {
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
                        modal={modalControls}
                    />
                </div>
                <Modal content={this.state.modalContent} modal={modalControls} />
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

    showModal(modalContent) {
        modalContent = _.extend({
            title: '',
            body: '',
            visible: true,
        }, modalContent);
        this.setState({ modalContent: modalContent });
    }

    hideModal() {
        this.setState({
            modalContent: {
                title: '',
                body: '',
                visible: false,
            },
        });
    }

} // end view

export default TopTagNetworks;
