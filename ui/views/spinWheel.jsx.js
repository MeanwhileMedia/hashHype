import React from '/node_modules/react';
import d3 from '/node_modules/d3';
import Hammer from '/node_modules/hammerjs';
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
import SpinWheelPart from './spinWheel-part.jsx.js';
import SpinWheelNewsColumns from './spinWheel-newsColumns.jsx.js';
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
    }

    componentDidMount() {
        this.initPanListeners();
        this.initAutoRotate();
    }

    componentDidUpdate() {
        if (this.lastUpdated === this.props.topCommentsLastUpdated) return; // we only need to run the below after we have received new stats:topComments from the server
        this.lastUpdated = this.props.topCommentsLastUpdated;
        // In case the wheel part rankings just changed, re-check that we have the correct one marked as focused
        const activePartEl = this.determineActiveWheelPart();
        if (!activePartEl) return;
        if (!activePartEl.classList.contains('active')) {
            this.props.focusTopComment(activePartEl.getAttribute('data-trend-name'));
        }
    }

    initPanListeners() {
        const self = this;
        const hammer = new Hammer(document.querySelector('.spinWheel .panCatcher'));
        hammer.on('panleft panright', (e) => {
            const wheelEl = document.querySelector('.spinWheel');
            if (!wheelEl) return;
            self.wheelShouldAutoRotate = false; // user has taken control. End the auto rotate started upon page load.
            self.props.toggleFreezeState(true);
            // console.log('velocity:', e.velocityX) // speed of pan (-,+)
            // console.log('deltaX:', e.deltaX) // pixel position change (-,+)
            const curRotation = self.getCurrentWheelRotation();
            const newRotation = Math.ceil(e.velocityX * 10 + curRotation); // We round to whole degrees to avoid jittering AND performance issues (returns if rounded angle shows no change)
            if (curRotation === newRotation) return;
            wheelEl.style.transform = `rotate(${newRotation}deg)`;
            const activePartEl = self.determineActiveWheelPart();
            if (!activePartEl) return;
            self.props.focusTopComment(activePartEl.getAttribute('data-trend-name'));
        });
        hammer.on('panend pancel', (e) => {
            self.props.toggleFreezeState(false);
        });
    }

    initAutoRotate() {
        const self = this;
        self.wheelShouldAutoRotate = true;
        const incrementByDeg = 0.1;
        const timeoutSpeed = 200;
        setTimeout(() => {
            if (!self.wheelShouldAutoRotate) return;
            const wheelEl = document.querySelector('.spinWheel');
            if (!wheelEl) return;
            const curRotation = self.getCurrentWheelRotation();
            const newRotation = curRotation - incrementByDeg;
            wheelEl.style.transform = `rotate(${newRotation}deg)`;
            const activePartEl = self.determineActiveWheelPart();
            if (activePartEl) self.props.focusTopComment(activePartEl.getAttribute('data-trend-name'));
            self.initAutoRotate();

            // Check if our 1st ranked topComment has reached its starting position yet.
            if (self.didAutoRotateToStart) {
                this.props.setPageIsReady();
                return;
            }
            const firstRankedTopComment = self.props.topComments.find(thisTopComment => thisTopComment.rank === 1);
            self.didAutoRotateToStart = self.autoRotateToTopComment(firstRankedTopComment);
        }, timeoutSpeed);
    }

    autoRotateToTopComment(destTopComment) {
        if (!destTopComment) return false;
        this.getSpinWheelPosDeg(destTopComment);
        if (!this.spinWheelPosDegs[destTopComment.id]) return false;
        const wheelEl = document.querySelector('.spinWheel');
        wheelEl.style.transform = `rotate(${this.spinWheelPosDegs[destTopComment.id]}deg)`;
        return true;
    }

    getSpinWheelPosDeg(destTopComment) {
        if (!destTopComment) return;
        this.spinWheelPosDegs = this.spinWheelPosDegs || {};

        const degreeAndOffsetRecord = []; //[{deg: 1, offset: 235}, {deg: 2, offset: 242}, etc]
        const wheelEl = document.querySelector('.spinWheel');
        const topCommentTextEl = document.querySelector(`[data-trend-name="${destTopComment.id}"] .wheel_part_text`);
        if (!topCommentTextEl) return;
        for (let deg = 0; deg <= 360; deg++) {
            wheelEl.style.transform = `rotate(${deg}deg)`;
            const boundingClientRect = topCommentTextEl.getBoundingClientRect();
            if (boundingClientRect.top < window.innerHeight) {
                const textOffCenterPx = (boundingClientRect.x+boundingClientRect.width/2) - (window.innerWidth/2);
                degreeAndOffsetRecord.push({deg: deg, offset: textOffCenterPx, top: boundingClientRect.top});
            }
        }
        degreeAndOffsetRecord.sort(function(a, b) {
            return Math.abs(a.offset) - Math.abs(b.offset);
        });
        if (!degreeAndOffsetRecord[0]) return;
        this.spinWheelPosDegs[destTopComment.id] = degreeAndOffsetRecord[0].deg;
    }

    getCurrentWheelRotation() {
        const wheelEl = document.querySelector('.spinWheel');
        if (!wheelEl) return;
        const curTransform = document.querySelector('.spinWheel').style.transform;
        let deg;
        if (curTransform === '') {
            deg = 0;
        } else {
            deg = parseFloat(curTransform.split('(')[1]);
        }
        return deg;
    }

    determineActiveWheelPart() {
        const viewportBoundingRect = document.querySelector('#main').getBoundingClientRect();
        let smallestOffset = null; // the wheel with the smallest measurement from center
        let activeWheelPartEl = null;
        document.querySelectorAll('.wheel_part .wheel_part_anchor').forEach((thisWheelEl) => {
            const wheelElBoundingRect = thisWheelEl.getBoundingClientRect();
            const wheelOffCenter = Math.abs(wheelElBoundingRect.left - viewportBoundingRect.width / 2);
            if ((!smallestOffset || wheelOffCenter < smallestOffset) && wheelElBoundingRect.top < viewportBoundingRect.height) {
                smallestOffset = wheelOffCenter;
                activeWheelPartEl = thisWheelEl.closest('.wheel_part');
            }
        });
        return activeWheelPartEl;
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
                const hasTopSymbolKey = thisTopComment.topSymbolHigh['1Hr'].key || thisTopComment.topSymbolLow['1Hr'].key || null;
                if (hasTopSymbolKey) {
                    const hasTopSymbol = thisTopComment.symbols.find(thisSymbol => thisSymbol.redisKey === hasTopSymbolKey);
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
                gNav: thisView.props.gNav
            });
            spinWheelParts.push(React.createElement(SpinWheelPart, wheelProps));
        });

        return spinWheelParts;
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
                    modal={this.modalControls}
                />
            </div>
        );
    } // end render
}

export default SpinWheel;
