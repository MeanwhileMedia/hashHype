import React from '/node_modules/react';
import d3 from '/node_modules/d3';
import Hammer from '/node_modules/hammerjs';
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
import TopTagWheelPart from './topTagNetworks-wheel-part.jsx';
import styles from './styles/topTagNetworks-wheel.css.js';

class TopTagWheel extends React.Component {
    // ////////
    // React lifecycle functions
    constructor(props) {
        super(props);
        this.state = {
            topTagCount: 10, // how many topTags to show in our wheel
            showOnlyTopTagsWithSymbols: true, // don't display an comments on our wheel unless they are associated with at least one symbol
            showTopTagSymbolsOnlyOnce: true // our server will send a max of 2 comments to represent any single symbol. Set this true and we will only render the higher scoring one. Will only apply when showOnlyTopTagsWithSymbols == true.
        };
    }

    componentDidMount() {
        this.initPanListeners();
        this.initAutoRotate();
    }

    componentDidUpdate() {
        // In case the wheel part rankings just changed, re-check that we have the correct one marked as focused
        const curRotation = this.getCurrentWheelRotation();
        const activePartEl = this.determineActiveWheelPart(curRotation);
        if (!activePartEl) return;
        if (!activePartEl.classList.contains('active')) {
            this.props.focusTopTag(activePartEl.getAttribute('data-trend-name'));
        }
    }

    initPanListeners() {
        const self = this;
        const hammer = new Hammer(document.querySelector('.topTags .panCatcher'));
        hammer.on('panleft panright', (e) => {
            self.wheelShouldAutoRotate = false; // user has taken control. End the auto rotate started upon page load.
            self.props.toggleFreezeState(true);
            // console.log('velocity:', e.velocityX) // speed of pan (-,+)
            // console.log('deltaX:', e.deltaX) // pixel position change (-,+)
            const curRotation = self.getCurrentWheelRotation();
            const newRotation = Math.ceil(e.velocityX * 10 + curRotation); // We round to whole degrees to avoid jittering AND performance issues (returns if rounded angle shows no change)
            if (curRotation === newRotation) return;
            document.querySelector('.topTagNetworks_wheel').style.transform = `rotate(${newRotation}deg)`;
            const activePartEl = self.determineActiveWheelPart(newRotation);
            if (!activePartEl) return;
            self.props.focusTopTag(activePartEl.getAttribute('data-trend-name'));
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
            const curRotation = self.getCurrentWheelRotation();
            const newRotation = curRotation - incrementByDeg;
            document.querySelector('.topTagNetworks_wheel').style.transform = `rotate(${newRotation}deg)`;
            const activePartEl = self.determineActiveWheelPart(newRotation);
            if (activePartEl) self.props.focusTopTag(activePartEl.getAttribute('data-trend-name'));
            self.initAutoRotate();

            // Check if our 1st ranked topTag has reached its starting position yet.
            if (self.didAutoRotateToStart) {
                this.props.setPageIsReady();
                return;
            }
            const firstRankedTopTag = self.props.topTags.find(thisTopTag => thisTopTag.rank === 1);
            self.didAutoRotateToStart = self.autoRotateToTopTag(firstRankedTopTag);
        }, timeoutSpeed);
    }

    autoRotateToTopTag(destTopTag) {
        if (!destTopTag) return false;
        const degreeAndOffsetRecord = []; //[{deg: 1, offset: 235}, {deg: 2, offset: 242}, etc]
        const wheelEl = document.querySelector('.topTagNetworks_wheel');
        const topTagTextEl = document.querySelector(`[data-trend-name="${destTopTag.id}"] .wheel_part_text`);
        for (let deg = 0; deg <= 360; deg++) {
            wheelEl.style.transform = `rotate(${deg}deg)`;
            const boundingClientRect = topTagTextEl.getBoundingClientRect();
            if (boundingClientRect.top < window.innerHeight) {
                const textOffCenterPx = (boundingClientRect.x+boundingClientRect.width/2) - (window.innerWidth/2);
                degreeAndOffsetRecord.push({deg: deg, offset: textOffCenterPx, top: boundingClientRect.top});
            }
        }
        degreeAndOffsetRecord.sort(function(a, b) {
            return Math.abs(a.offset) - Math.abs(b.offset);
        });
        wheelEl.style.transform = `rotate(${degreeAndOffsetRecord[0].deg}deg)`;
        return true;
    }

    getCurrentWheelRotation() {
        const wheelEl = document.querySelector('.topTagNetworks_wheel');
        if (!wheelEl) return;
        const curTransform = document.querySelector('.topTagNetworks_wheel').style.transform;
        let deg;
        if (curTransform === '') {
            deg = 0;
        } else {
            deg = parseFloat(curTransform.split('(')[1]);
        }
        return deg;
    }

    determineActiveWheelPart(curRotation) {
        const windowHeight = window.outerHeight;
        const windowWidth = window.outerWidth;
        let smallestOffset = null; // the wheel with the smallest measurement from center
        let activeWheelPartEl = null;
        document.querySelectorAll('.wheel_part').forEach((el) => {
            const elBoundingClientRect = el.getBoundingClientRect();
            const wheelCenter = elBoundingClientRect.left + elBoundingClientRect.width / 2;
            const wheelOffCenter = Math.abs(windowWidth / 2 - wheelCenter);
            if ((!smallestOffset || wheelOffCenter < smallestOffset) && elBoundingClientRect.top < windowHeight) {
                smallestOffset = wheelOffCenter;
                activeWheelPartEl = el;
            }
        });
        return activeWheelPartEl;
    }

    createTopTagWheelParts(css) {
        if (this.props.topTags.length === 0) { return []; }
        const thisView = this;
        let hierarchyData = { name: 'topTags', children: this.props.topTags };
        let allMsgCounts = []; // for setting color and width of topTagWheelParts

        hierarchyData.children.sort((a, b) => b.totalPoints['1Hr'] - a.totalPoints['1Hr']);

        if (this.state.showOnlyTopTagsWithSymbols) {
            let reducedTopTags = [];
            const reducedTopTagsBySymbol = {}; // {GME: [comment3, comment1], APPL: [comment32], etc..} - used for picking the higher scoring symbol comment when showTopTagSymbolsOnlyOnce == true
            hierarchyData.children.forEach((thisTopTag) => {
                const hasSymbol = thisTopTag.topSymbolHigh['1Hr'].key || thisTopTag.topSymbolLow['1Hr'].key || null;
                if (hasSymbol) {
                    reducedTopTagsBySymbol[hasSymbol] = reducedTopTagsBySymbol[hasSymbol] || [];
                    reducedTopTagsBySymbol[hasSymbol].push(thisTopTag);
                }
            });
            if (this.state.showTopTagSymbolsOnlyOnce) {
                Object.values(reducedTopTagsBySymbol).forEach((theseTopTags) => {
                    theseTopTags.sort((a, b) => b.totalPoints['1Hr'] - a.totalPoints['1Hr']);
                    reducedTopTags.push(theseTopTags[0]);
                });
            } else {
                reducedTopTags = Object.values(reducedTopTagsBySymbol).flat()
            }
            hierarchyData.children = reducedTopTags;
        }
        if (hierarchyData.children.length === 0) { return []; }

        hierarchyData.children = hierarchyData.children.slice(0, this.state.topTagCount);
        hierarchyData.children.forEach( (topTag) => {
            const getUniquePointCount = (lastTriedUniqueCount) => {
                if (allMsgCounts.indexOf(lastTriedUniqueCount) !== -1) { // Because we use this array to rank trends, we cannot use tie scores. If a tie is found, increment the dup by 1 until it's no longer a dup.
                    lastTriedUniqueCount++;
                    getUniquePointCount(lastTriedUniqueCount);
                    return;
                }
                allMsgCounts.push(lastTriedUniqueCount);
                topTag.totalPoints['1Hr'] = lastTriedUniqueCount;
            };
            getUniquePointCount(topTag.totalPoints['1Hr']);
        });

        hierarchyData = d3.hierarchy(hierarchyData).sum((d) => {
            if (!d.totalPoints) return;
            return d.totalPoints['1Hr'] //+ allMsgCounts[0] // The largest part will be at most 2x the size of the smallest
        });

        const partition = d3.partition()(hierarchyData);

        const topTagWheelParts = [];
        partition.children.forEach((partitionCoords, index) => {
            const wheelProps = Object.assign(partitionCoords, {
                key: partitionCoords.data.absKey,
                minOuterRadius: css.minOuterRadius,
                maxOuterRadius: css.maxOuterRadius,
                allMsgCounts: allMsgCounts,
                gNav: thisView.props.gNav
            });
            topTagWheelParts.push(React.createElement(TopTagWheelPart, wheelProps));
        });

        return topTagWheelParts;
    }

    render() {
        const thisView = this;
        const css = styles.generate(this);
        const topTagWheelParts = this.createTopTagWheelParts(css);

        return (
            <div className="topTagNetworks_wheel" style={css.wheel}>
                <svg
                    style={css.wheel_svg}
                    preserveAspectRatio="xMinYMin meet"
                    viewBox={`0 0 ${css.maxOuterRadius * 2} ${css.maxOuterRadius * 2}`}
                >
                    <g transform={`translate(${css.maxOuterRadius},${css.maxOuterRadius})`}>
                        {topTagWheelParts}
                    </g>
                </svg>
                <div style={css.wheel_panCatcher} className="panCatcher" />
            </div>
        );
    } // end render
}

export default TopTagWheel;
