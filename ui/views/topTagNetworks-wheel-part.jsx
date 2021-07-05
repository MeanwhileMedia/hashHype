import React from '/node_modules/react';
import d3 from '/node_modules/d3';
import Radium from '/node_modules/radium';
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
import styles from './styles/topTagNetworks-wheel-part.css.js';

class TopTagWheelPart extends React.Component {
  // ////////
  // React lifecycle functions
  constructor(props) {
    super(props);
    this.state = {
      name: '',
      justGrew: false,
      wheelGrowthCount: 0, // for flashing the partition to represent growth. Flashes wheelGrowthCount times
    };
  }

  render() {
    const thisView = this;
    this.props.data.rank = this.props.allMsgCounts.indexOf(this.props.data.totalPoints['1Hr']) + 1;

    let topSymbolSymbol = '';
    if (this.props.data.topSymbolHigh['1Hr'].key) {
        let wordTopSymbolObj;
        thisView.props.data.symbols.forEach((thisSymbol) => {
            const thisSymbolKey = `symbol:${thisSymbol.type}:${thisSymbol.symbol}`;
            if (thisSymbolKey === this.props.data.topSymbolHigh['1Hr'].key) wordTopSymbolObj = thisSymbol;
        });
        if (wordTopSymbolObj) topSymbolSymbol = wordTopSymbolObj.symbol;
    }

    const rankSpace = this.props.maxOuterRadius - this.props.minOuterRadius;
    const innerPadding = (rankSpace/2);
    const rankPercentage = 1 - (Math.max(...this.props.allMsgCounts) - this.props.data.totalPoints['1Hr']) / (Math.max(...this.props.allMsgCounts) - Math.min(...this.props.allMsgCounts));
    const outerRadius = (this.props.minOuterRadius+innerPadding) + ((rankSpace-innerPadding)*rankPercentage);

    const x = d3.scaleLinear().range([0, 2 * Math.PI]);
    const y = d3.scaleSqrt().range([0, this.props.minOuterRadius]);
    const arc = d3.arc()
      .startAngle(d => Math.max(0, Math.min(2 * Math.PI, x(d.x0))))
      .endAngle(d => Math.max(0, Math.min(2 * Math.PI, x(d.x1))))
      .innerRadius(d => thisView.props.minOuterRadius * 0.9)
      .outerRadius(d => outerRadius);

    const css = styles.generate(this);
    let growthAnim = {};
    if (this.state.justGrew) {
      growthAnim = css['.wheel_part__grew'];
    }

    const statRowSpacing = Math.max(this.props.maxOuterRadius, window.outerHeight) / 7 / 10; // rem

    const mainClasses = `wheel_part ${this.props.data.isFocused ? 'active' : ''}`;
    return (
      <g className={mainClasses} data-trend-name={this.props.data.id}>
        <path
          d={arc(this.props)}
          style={Object.assign(growthAnim, css['.wheel_part_path'])}
        />
        <g className="wheel_part_text" transform={`rotate(${this.computeTextRotation(this.props, x)})`}>

            {/*
          <g transform={`rotate(90 ${this.props.maxOuterRadius} 0)`}>
            <text
              className="heading4 font__heavy font__title__light"
              textAnchor="middle"
              x={this.props.maxOuterRadius}
              y={`-${statRowSpacing * 2}rem`}
              dy="-6rem"
            >
                Rank
            </text>
            <text
              className="heading2 font__light"
              textAnchor="middle"
              x={this.props.maxOuterRadius}
              y={`-${statRowSpacing * 2}rem`}
            >
              {this.getNumberOrdinal(this.props.data.rank)}
            </text>
          </g>



          <g transform={`rotate(90 ${this.props.maxOuterRadius} 0)`}>
            <text
              className="heading4 font__heavy font__title__light"
              textAnchor="middle"
              x={this.props.maxOuterRadius}
              y={`-${statRowSpacing}rem`}
              dy="-6rem"
            >
                Points
            </text>
            <text
              className="heading2 font__light"
              textAnchor="middle"
              x={this.props.maxOuterRadius}
              y={`-${statRowSpacing}rem`}
            >
              {this.props.data.totalPoints['1Hr'].toLocaleString('en')}
            </text>
          </g>
          */}

          <g transform={`rotate(90 ${this.props.maxOuterRadius} 0)`}>
            <text
              className="heading3 font__light"
              textAnchor="middle"
              style={css['.wheel_part__title']}
              dx={this.props.maxOuterRadius}
              dy="-2rem"
            >
              {topSymbolSymbol}
            </text>
          </g>

        </g>
      </g>
    );
  }

  componentDidUpdate(prevProps, prevState) {
    const topTagMsgCount = this.props.data.totalPoints['1Hr'];
    const prevtopTagMsgCount = prevProps.data.totalPoints['1Hr'];

    if (topTagMsgCount > prevtopTagMsgCount && !prevState.justGrew) {
      // Strobe the wheel part once for every new message.
      this.strobePart({ times: topTagMsgCount - prevtopTagMsgCount });
    }
  }

  strobePart(opts) {
    this.setState({ justGrew: true, wheelGrowthCount: opts.times }, function () {
      this.state.justGrew = false; // to stop an infinite loop
    });
  }

  computeTextRotation(d, x) {
    return (x((d.x0 + d.x1) / 2) - Math.PI / 2) / Math.PI * 180;
  }

  getNumberOrdinal(n) {
    // https://ecommerce.shopify.com/c/ecommerce-design/t/ordinal-number-in-javascript-1st-2nd-3rd-4th-29259
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
}

export default Radium(TopTagWheelPart);
