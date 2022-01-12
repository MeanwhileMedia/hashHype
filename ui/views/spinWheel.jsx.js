import React from '/node_modules/react';
import d3 from '/node_modules/d3';
import Hammer from '/node_modules/hammerjs';
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
import SpinWheelPart from './spinWheel-part.jsx.js';
import SpinWheelNewsColumns from './spinWheel-newsColumns.jsx.js';
import utils from '../helpers/utils.js'

import styles from './styles/spinWheel.css.js';

class SpinWheel extends React.Component {
    // ////////
    // React lifecycle functions
    constructor(props) {
        super(props);
        this.state = {
            topCommentCount: 10, // how many topComments to show in our wheel
            showOnlyTopCommentsWithSymbols: true, // don't display an comments on our wheel unless they are associated with at least one symbol
            showTopCommentSymbolsOnlyOnce: true, // our server will send a max of 2 comments to represent any single symbol. Set this true and we will only render the higher scoring one. Will only apply when showOnlyTopCommentsWithSymbols == true.
            showTopCommentSymbolTypes: ['stock'] // can be set to one or more of strings equaling a symbol.type
        };

        this.lastUpdated = this.props.topCommentsLastUpdated;

        this.pendingKeyPress = false; // will be set true immediately after one of our registerKeyboardCtrls is activated. This flag will trigger an auto rotate.

        this.defaultActiveRank = 3; // We will auto rotate to 3rd ranked wheel part upon initial load.
        this.didAutoRotateToStart = false;
        this.isDemoRotating = false;
    }

    componentDidMount() {
        this.initPanListeners();
        this.registerKeyboardCtrls();
        this.autoRotateToStart();
    }

    componentDidUpdate(prevProps) {
        const self = this;

        if (prevProps.focusedTopComment && this.props.focusedTopComment && prevProps.focusedTopComment.id !== this.props.focusedTopComment.id) {
            // The focused comment just changed
            if (this.pendingKeyPress) {
                this.autoRotateToTopComment(this.props.focusedTopComment, true);
                this.pendingKeyPress = false;
            }
        }

        // we only need to run the below after we have received new stats:topComments from the server
        if (this.lastUpdated === this.props.topCommentsLastUpdated) return;
        this.lastUpdated = this.props.topCommentsLastUpdated;

        this.spinWheelPartsTopmostPosMatrix = {}; // reset our cached wheel part positions now that our data has changed.

        // In case the wheel part rankings just changed, re-check that the focused comment is still on top
        const topmostPartEl = this.determineTopmostWheelPart();
        if (this.props.focusedTopComment && topmostPartEl && topmostPartEl.getAttribute('data-trend-name') !== this.props.focusedTopComment.id && !self.isDemoRotating) {
            this.autoRotateToTopComment(this.props.focusedTopComment, true);
        }
    }

    initPanListeners() {
        const self = this;
        const hammer = new Hammer(document.querySelector('.spinWheel .panCatcher'));
        let prevFocusedComment;
        hammer.on('panleft panright', (e) => {
            self.isDemoRotating = false;
            const wheelEl = document.querySelector('.spinWheel');
            if (!wheelEl) return;
            self.props.toggleFreezeState(true);
            // console.log('velocity:', e.velocityX) // speed of pan (-,+)
            // console.log('deltaX:', e.deltaX) // pixel position change (-,+)

            const curRotation = self.getCurrentWheelRotation();
            const curRotationDegs = self.convertMatrixToDegs(curRotation);
            const newRotationDegs = Math.ceil(e.velocityX * 10 + curRotationDegs); // We round to whole degrees to avoid jittering AND performance issues (returns if rounded angle shows no change)
            const newRotation = self.convertDegsToMatrix(newRotationDegs);

            if (curRotation === newRotation) return;
            self.setCurrentWheelRotation(newRotation, 'none');
            const activePartEl = self.determineTopmostWheelPart();
            if (activePartEl) {
                const focusedComment = self.props.topComments.find(thisTopComment => thisTopComment.id === activePartEl.getAttribute('data-trend-name'));
                if (focusedComment !== prevFocusedComment) {
                    prevFocusedComment = focusedComment;
                    self.props.focusTopComment(focusedComment);
                }
            }
        });
        hammer.on('panend pancel', (e) => {
            self.props.toggleFreezeState(false);
        });
    }

    autoRotateToStart () {
        const self = this;
        const defaultActiveTopComment = this.props.topComments.find(thisTopComment => thisTopComment.rank === self.defaultActiveRank);
        this.autoRotateToTopComment(defaultActiveTopComment);
        this.props.focusTopComment(defaultActiveTopComment);
        this.props.setPageIsReady();
        setTimeout(() => {
            this.initDemoRotate();
        }, 0);
    }
    initDemoRotate() { // upon pageload the wheel slowly turns on it's own (to demonstrated the functionality to the user)
        const self = this;
        const wheelEl = document.querySelector('.spinWheel');
        if (!wheelEl) return;

        self.isDemoRotating = true;
        self.setCurrentWheelRotation(self.convertDegsToMatrix(360), `transform 80s linear`);

        let prevTopmostPartEl;
        const checkTopmostWheelPart = () => {
            if (!self.isDemoRotating) return;
            const topmostPartEl = self.determineTopmostWheelPart();
            if (topmostPartEl && topmostPartEl !== prevTopmostPartEl) {
                prevTopmostPartEl = topmostPartEl;
                const focusedComment = self.props.topComments.find(thisTopComment => thisTopComment.id === topmostPartEl.getAttribute('data-trend-name'));
                self.props.focusTopComment(focusedComment);
            }
            setTimeout(checkTopmostWheelPart, 1000);
        };
        checkTopmostWheelPart();
    }

    registerKeyboardCtrls() {
        const self = this;
        const allKeyCodes = [39, 40, 37, 38]; //arrows
        allKeyCodes.forEach((thisCode) => {
            utils.registerKeyboardCtrlsListener(`spinWheelKeyboard${thisCode}`, () => {
                // the changing of focusedTopTag is handled by our main topCommentStats.jsx class. However, we do need to catch which button was pressed to determine things like - should we auto rotate and in what direction.
                self.pendingKeyPress = thisCode;
            }, {
                keyCode: thisCode,
                ctrlKey: false,
                shiftKey: false
            });
        });
    }

    getCurrentWheelRotation(wheelEl) {
        wheelEl = wheelEl || document.querySelector('.spinWheel');
        if (!wheelEl) return 0;
        const wheelComputedStyle = window.getComputedStyle(wheelEl);
        const curTransformMatrix = wheelComputedStyle.transform;
        if (!curTransformMatrix) return 'none';
        return curTransformMatrix;
    }
    setCurrentWheelRotation(transform, transition = 'none', wheelEl) { // transform and transition are strings that are the exact CSS setting to apply
        wheelEl = wheelEl || document.querySelector('.spinWheel');
        if (!wheelEl) return;
        wheelEl.style.transform = transform; // expects a matrix string
        wheelEl.style.transition = transition;
    }

    autoRotateToTopComment(destTopComment, withTransition = false) {
        if (!destTopComment) return;
        let transition = 'none';
        if (withTransition) transition = `transform .2s`;
        this.isDemoRotating = false;

        this.getSpinWheelPartDegToActive(destTopComment);
        let targetRotation = this.spinWheelPartsTopmostPosMatrix[destTopComment.id];
        if (!targetRotation) return;

        this.setCurrentWheelRotation(targetRotation, transition);
    }

    getSpinWheelPartDegToActive(destTopComment) {
        const self = this;
        if (!destTopComment) return;
        this.spinWheelPartsTopmostPosMatrix = this.spinWheelPartsTopmostPosMatrix || {};
        if (this.spinWheelPartsTopmostPosMatrix[destTopComment.id]) return;

        // clone the wheel, rotate that clone in 1 degree intervals, take measurements at each interval, determine which degree places the text closest to top center, delete clone node.
        const degreeAndOffsetRecord = []; //[{matrix: 1, offset: 235}, {matrix: 2, offset: 242}, etc]
        const wheelEl = document.querySelector('.spinWheel');
        const wheelElClone = wheelEl.cloneNode(true);
        wheelElClone.style.pointerEvents = 'none';
        wheelElClone.style.opacity = 0;
        wheelEl.parentNode.appendChild(wheelElClone);
        const topCommentTextEl = wheelElClone.querySelector(`[data-trend-name="${destTopComment.id}"] .wheel_part_anchor`);
        if (!topCommentTextEl) {
            wheelElClone.remove();
            return;
        }
        for (let deg = 0; deg <= 360; deg++) {
            self.setCurrentWheelRotation(`rotate(${deg}deg)`, 'none', wheelElClone);
            const boundingClientRect = topCommentTextEl.getBoundingClientRect();
            if (boundingClientRect.top < window.innerHeight) {
                const textOffCenterPx = (boundingClientRect.x+boundingClientRect.width/2) - (window.innerWidth/2);
                degreeAndOffsetRecord.push({matrix: self.getCurrentWheelRotation(wheelElClone), offset: textOffCenterPx, top: boundingClientRect.top});
            }
        }
        wheelElClone.remove()

        degreeAndOffsetRecord.sort(function(a, b) {
            return Math.abs(a.offset) - Math.abs(b.offset);
        });
        if (!degreeAndOffsetRecord[0]) return;
        this.spinWheelPartsTopmostPosMatrix[destTopComment.id] = degreeAndOffsetRecord[0].matrix;
    }

    determineTopmostWheelPart() {
        const viewportBoundingRect = document.querySelector('#main').getBoundingClientRect();
        let smallestOffset = null; // the wheel with the smallest measurement from center
        let topmostWheelPartEl = null;
        document.querySelectorAll('.wheel_part .wheel_part_anchor').forEach((thisWheelEl) => {
            const wheelElBoundingRect = thisWheelEl.getBoundingClientRect();
            const wheelOffCenter = Math.abs(wheelElBoundingRect.left - viewportBoundingRect.width / 2);
            if ((!smallestOffset || wheelOffCenter < smallestOffset) && wheelElBoundingRect.top < viewportBoundingRect.height) {
                smallestOffset = wheelOffCenter;
                topmostWheelPartEl = thisWheelEl.closest('.wheel_part');
            }
        });
        return topmostWheelPartEl;
    }

    createSpinWheelParts(css) {
        if (this.props.topComments.length === 0) { return []; }
        const thisView = this;
        let hierarchyData = { name: 'topComments', children: this.props.topComments };
        let allMsgCounts = []; // for setting color and width of spinWheelParts

        hierarchyData.children.sort((a, b) => b.totalPoints['1Hr'] - a.totalPoints['1Hr']);

        if (this.state.showOnlyTopCommentsWithSymbols) {
            let reducedTopComments = [];
            const reducedTopCommentsBySymbol = {}; // {GME: [comment3, comment1], APPL: [comment32], etc..} - used for picking the higher scoring symbol comment when showTopCommentSymbolsOnlyOnce == true
            hierarchyData.children.forEach((thisTopComment) => {
                const hasTopSymbolKey = thisTopComment.topSymbolHigh['1Hr'] || thisTopComment.topSymbolLow['1Hr'] || null;
                if (hasTopSymbolKey) {
                    const hasTopSymbol = thisTopComment.symbols.find(thisSymbol => {
                        const thisSymbolRedisKey = `symbol:${thisSymbol.type}:${thisSymbol.symbol}`;
                        return thisSymbolRedisKey === hasTopSymbolKey;
                    });
                    if (hasTopSymbol && thisView.state.showTopCommentSymbolTypes.indexOf(hasTopSymbol.type) !== -1) {
                        reducedTopCommentsBySymbol[hasTopSymbolKey] = reducedTopCommentsBySymbol[hasTopSymbolKey] || [];
                        reducedTopCommentsBySymbol[hasTopSymbolKey].push(thisTopComment);
                    }
                }
            });
            if (this.state.showTopCommentSymbolsOnlyOnce) {
                Object.values(reducedTopCommentsBySymbol).forEach((theseTopComments) => {
                    theseTopComments.sort((a, b) => b.totalPoints['1Hr'] - a.totalPoints['1Hr']);
                    reducedTopComments.push(theseTopComments[0]);
                });
            } else {
                reducedTopComments = Object.values(reducedTopCommentsBySymbol).flat()
            }
            hierarchyData.children = reducedTopComments;
        }
        if (hierarchyData.children.length === 0) { return []; }

        hierarchyData.children = hierarchyData.children.slice(0, this.state.topCommentCount);
        hierarchyData.children.forEach( (topComment) => {
            const getUniquePointCount = (lastTriedUniqueCount) => {
                if (allMsgCounts.indexOf(lastTriedUniqueCount) !== -1) { // Because we use this array to rank trends, we cannot use tie scores. If a tie is found, increment the dup by 1 until it's no longer a dup.
                    lastTriedUniqueCount++;
                    getUniquePointCount(lastTriedUniqueCount);
                    return;
                }
                allMsgCounts.push(lastTriedUniqueCount);
                topComment.totalPoints['1Hr'] = lastTriedUniqueCount;
            };
            getUniquePointCount(topComment.totalPoints['1Hr']);
        });

        hierarchyData = d3.hierarchy(hierarchyData).sum((d) => {
            if (!d.totalPoints) return;
            return d.totalPoints['1Hr'] //+ allMsgCounts[0] // The largest part will be at most 2x the size of the smallest
        });

        const partition = d3.partition()(hierarchyData);

        const spinWheelParts = [];
        partition.children.forEach((partitionCoords, index) => {
            const wheelProps = Object.assign(partitionCoords, {
                key: partitionCoords.data.absKey,
                minOuterRadius: css.minOuterRadius,
                maxOuterRadius: css.maxOuterRadius,
                allMsgCounts: allMsgCounts,
                gNav: thisView.props.gNav,
                focusedTopComment: thisView.props.focusedTopComment
            });
            spinWheelParts.push(React.createElement(SpinWheelPart, wheelProps));
        });

        return spinWheelParts;
    }

    convertMatrixToDegs(matrixStr) { // returns int degrees
        const matrixVals = matrixStr.split('(')[1].split(')')[0].split(',');
        const degrees = Math.round(Math.atan2(matrixVals[1], matrixVals[0]) * (180/Math.PI));
        return degrees;
    }
    convertDegsToMatrix(degsInt) { // returns matrix string
        const radians = degsInt * Math.PI / 180;
        const matrix = [
            Math.cos(radians),
            Math.sin(radians),
            Math.sin(radians) * -1,
            Math.cos(radians),
            0,
            0
        ];
        const matrixStr = `matrix(${matrix[0]},${matrix[1]},${matrix[2]},${matrix[3]},${matrix[4]},${matrix[5]})`;
        return matrixStr;
    }

    render() {
        const thisView = this;
        const css = styles.generate(this);
        const spinWheelParts = this.createSpinWheelParts(css);

        return (
            <div className="spinWheel_wrapper">
                <div className="spinWheel" style={css.wheel}>
                    <svg
                        style={css.wheel_svg}
                        preserveAspectRatio="xMinYMin meet"
                        viewBox={`0 0 ${css.maxOuterRadius * 2} ${css.maxOuterRadius * 2}`}
                    >
                        <g transform={`translate(${css.maxOuterRadius},${css.maxOuterRadius})`}>
                            {spinWheelParts}
                        </g>
                    </svg>
                    <div style={css.wheel_panCatcher} className="panCatcher" />
                </div>
                <SpinWheelNewsColumns
                    topComments={this.props.topComments}
                    focusedTopComment={this.props.focusedTopComment}
                    modal={this.modalControls}
                />
            </div>
        );
    } // end render
}

export default SpinWheel;
