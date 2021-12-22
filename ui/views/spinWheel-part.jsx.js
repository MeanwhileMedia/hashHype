import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import d3 from '/node_modules/d3';
import Icon from './hbWidgets/icon.jsx.js'
import socketViewResponses from '../helpers/hbClientSocketViewResponses.js';
import commentFormatter from '../helpers/commentFormatter.js'

import styles from './styles/spinWheel-part.css.js';

class SpinWheelPart extends React.Component {
    // ////////
    // React lifecycle functions
    constructor(props) {
        super(props);
        this.state = {
            name: '',
            justGrew: false,
            wheelGrowthCount: 0, // for flashing the partition to represent growth. Flashes wheelGrowthCount times
        };
        this.wheelPartGRef = React.createRef();
        this.wheelPartSymbolTitleText = React.createRef();
    }

    componentDidUpdate(prevProps, prevState) {
        const topCommentMsgCount = this.props.data.totalPoints['1Hr'];
        const prevtopCommentMsgCount = prevProps.data.totalPoints['1Hr'];

        if (topCommentMsgCount > prevtopCommentMsgCount && !prevState.justGrew) {
            // Strobe the wheel part once for every new point.
            this.strobePart({ times: topCommentMsgCount - prevtopCommentMsgCount });
        }

        this.applyPostRenderStyleTransitions();
    }

    renderActiveTopCommentStats(){
        const self = this;
        const css = styles.generate(this);

        const statsEl = (
            <div>
                <h5
                    className="heading5"
                    style={Object.assign({}, css.wheel_part_title_label, css.wheel_part_title_label__rank)}
                >
                    Rank
                </h5>
                <h3
                    className="heading3"
                    style={Object.assign({}, css.wheel_part_title, css.wheel_part_title__rank, css.wheel_text__h3)}
                >
                    {commentFormatter.getNumberOrdinal(this.props.data.rank)}
                </h3>
            </div>
        );
        return statsEl;
    }

    renderActiveTopCommentSymbolStats(){
        const self = this;
        const css = styles.generate(this);
        let symbolStatsEl = null;

        let topSymbol = self.props.data.topSymbolHigh['1Hr'] || self.props.data.topSymbolLow['1Hr'] || null;
        if (topSymbol) {
            self.props.data.symbols.forEach((thisSymbol) => {
                const thisSymbolKey = `symbol:${thisSymbol.type}:${thisSymbol.symbol}`;
                if (thisSymbolKey === topSymbol) topSymbol = thisSymbol;
            });
        }
        if (!topSymbol) return symbolStatsEl;
        self.props.data.renderedSymbol = topSymbol; // save for easy access by other classes

        let symbolText = topSymbol.symbol;
        const emojiSymbolHtml = self.getEmojiAssocHtml(topSymbol);
        if (emojiSymbolHtml) symbolText = emojiSymbolHtml;

        symbolStatsEl = (
            <div>
                <h5
                    className="heading5"
                    style={Object.assign({}, css.wheel_part_title_label, css.wheel_text__h4)}
                >
                    {topSymbol.type}
                </h5>
                <h2
                    ref={this.wheelPartSymbolTitleText}
                    className="heading2"
                    style={Object.assign({}, css.wheel_part_title, css.wheel_part_title__symbol, css.wheel_text__h2)}
                    dangerouslySetInnerHTML={{__html: symbolText}}
                />
            </div>
        );
        return symbolStatsEl;
    }

    getEmojiAssocHtml(emojiSymbol) {
        if (emojiSymbol.type !== 'emoji' || !emojiSymbol.assocs[0]) return; // For now, we always render the first assoc in the array. We don't currently have a use case for an emoji having more than one assoc
        const thisSymbolAssoc = emojiSymbol.assocs[0];
        let thisSymbolAssocHtml = '';
        if (thisSymbolAssoc.type === 'unicode') {
            thisSymbolAssocHtml = thisSymbolAssoc.assoc;
        }
        if (thisSymbolAssoc.type === 'image') {
            thisSymbolAssocHtml = `<span class="emoji emoji__48"><span style="background-image: url('${thisSymbolAssoc.assoc}')"></span></span>`;
        }
        return thisSymbolAssocHtml;
    }

    applyPostRenderStyleTransitions() {
        const textEls = this.wheelPartGRef.current.querySelectorAll('h2, h3, h5, .wheel_part_buttons');
        if (this.props.focusedTopComment.id === this.props.data.id) {
            textEls.forEach((textEl) => {
                textEl.style.opacity = 1;
            });
        } else {
            textEls.forEach((textEl) => {
                textEl.style.opacity = 0;
            });
            if (this.wheelPartSymbolTitleText.current && this.wheelPartSymbolTitleText.current.style) {
                this.wheelPartSymbolTitleText.current.style.opacity = 0.2;
            }
        }
    }

    strobePart(opts) {
        this.setState({ justGrew: true, wheelGrowthCount: opts.times }, function () {
            this.state.justGrew = false; // to stop an infinite loop
        });
    }

    render() {
        const self = this;
        this.props.data.rank = this.props.allMsgCounts.indexOf(this.props.data.totalPoints['1Hr']) + 1;

        const rankSpace = this.props.maxOuterRadius - this.props.minOuterRadius;
        const innerPadding = (rankSpace*.2);
        const rankPercentage = 1 - (Math.max(...this.props.allMsgCounts) - this.props.data.totalPoints['1Hr']) / (Math.max(...this.props.allMsgCounts) - Math.min(...this.props.allMsgCounts));
        const outerRadius = (this.props.minOuterRadius+innerPadding) + ((rankSpace-innerPadding)*rankPercentage);

        const x = d3.scaleLinear().range([0, 2 * Math.PI]);
        const y = d3.scaleSqrt().range([0, this.props.minOuterRadius]);
        const arc = d3.arc()
        .startAngle(d => Math.max(0, Math.min(2 * Math.PI, x(d.x0))))
        .endAngle(d => Math.max(0, Math.min(2 * Math.PI, x(d.x1))))
        .innerRadius(d => self.props.minOuterRadius)
        .outerRadius(d => outerRadius);

        const css = styles.generate(this);
        let growthAnim = {};
        if (this.state.justGrew) {
            growthAnim = css['wheel_part__grew'];
        }

        const topCommentStatsEls = this.renderActiveTopCommentStats();
        const topCommentSymbolStatsEl = this.renderActiveTopCommentSymbolStats();

        const mainClasses = `wheel_part ${this.props.focusedTopComment && this.props.focusedTopComment.id === this.props.data.id ? 'active' : ''}`;
        return (
            <g ref={this.wheelPartGRef} className={mainClasses} data-trend-name={this.props.data.id} style={css.wheel_part}>
                <path
                d={arc(this.props)}
                style={Object.assign(growthAnim, css['wheel_part_path'])}
                />

                <g className="wheel_part_text" transform={`rotate(${this.computeTextRotation(this.props, x)})`}>
                    <foreignObject transform={`rotate(90 ${this.props.maxOuterRadius} 0)`} x={this.props.maxOuterRadius} y="-19rem" width="1" height="1000" style={Object.assign({}, css.wheel_part_text_wrapper)}>
                        <div style={Object.assign({}, css.wheel_part_text_inner)}>
                            <div style={Object.assign({}, css.wheel_part_text_section)}>{topCommentStatsEls}</div>
                            <div style={Object.assign({}, css.wheel_part_text_section)}>{topCommentSymbolStatsEl}</div>
                            <div style={Object.assign({}, css.wheel_part_text_section)}>
                                <div className="wheel_part_buttons" style={Object.assign({}, css.wheel_part_buttons)}>
                                    <button className="button__sev1 button__light" onClick={self.props.gNav.showSetTrendActionModal.bind(self.props.gNav)} style={Object.assign({}, css.wheel_text__button)}>
                                        <Icon iconName="data_saver_on" height="100%" />
                                        Action
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="wheel_part_anchor" style={css.wheel_part_anchor}></div>
                    </foreignObject>
                </g>
            </g>
        );
    }

    computeTextRotation(d, x) {
        return (x((d.x0 + d.x1) / 2) - Math.PI / 2) / Math.PI * 180;
    }

}

export default Radium(SpinWheelPart);
