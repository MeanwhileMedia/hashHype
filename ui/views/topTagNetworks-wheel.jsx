import React from '/node_modules/react';
import d3 from '/node_modules/d3';
import Hammer from '/node_modules/hammerjs';
import _ from '/node_modules/underscore';
import socketViewResponses from '../helpers/hbClientSocketViewResponses';
import TopTagWheelPart from './topTagNetworks-wheel-part.jsx';
import styles from './styles/topTagNetworks-wheel.css';

class TopTagWheel extends React.Component {
  // ////////
  // React lifecycle functions
  constructor(props) {
    super(props);
    this.state = {
      // topTagStats: {},
      topTagCount: 20, // how many topTags to show in our wheel
    };
  }

  componentDidMount() {
    this.initPanListeners();
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

  initPanListeners() {
    const thisView = this;
    const hammertime = new Hammer(document.querySelector('.topTags .panCatcher'));
    hammertime.on('pan', (e) => {
      const curRotation = thisView.getCurrentWheelRotation();
      const newRotation = e.velocityX * 10 + curRotation;
      document.querySelector('.topTagNetworks_wheel').style.transform = `rotate(${newRotation}deg)`;
      const activePartEl = thisView.determineActiveWheelPart(newRotation);
      if (!activePartEl) return;
      thisView.props.focusTopTag(activePartEl.getAttribute('data-trend-name'));
    });
  }

  createTopTagWheelParts(css) {
    if (_.size(this.props.topTags) === 0) { return []; }
    const thisView = this;
    let hierarchyData = { name: 'topTags', children: this.props.topTags };
    let allMsgCounts = []; // for setting color and width of topTagWheelParts

    hierarchyData.children.sort((a, b) => b.totalPoints['1Hr'] - a.totalPoints['1Hr']);

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
    _.each(partition.children, (partitionCoords, index) => {
      const wheelProps = _.extend(partitionCoords, {
        key: partitionCoords.data.absKey,
        minOuterRadius: css.minOuterRadius,
        maxOuterRadius: css.maxOuterRadius,
        allMsgCounts,
      });
      topTagWheelParts.push(React.createElement(TopTagWheelPart, wheelProps));
    });

    return topTagWheelParts;
  }

  getCurrentWheelRotation() {
    const curTransform = document.querySelector('.topTagNetworks_wheel').style.transform;
    let deg;
    if (curTransform === '') {
      deg = 0;
    } else {
      deg = parseInt(curTransform.split('(')[1]);
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
}

export default TopTagWheel;
