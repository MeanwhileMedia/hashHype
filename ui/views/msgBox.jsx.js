import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import Icon from './hbWidgets/icon.jsx.js'

import styles from './styles/msgBox.css.js';

class MsgBox extends React.Component {
    constructor(props) {
        super(props);

        this.props.onCarouselClick = this.props.onCarouselClick || function(direction, e){};
    }

    render() {
        const css = styles.generate(this);

        let extraStyles = {};
        if (this.props.maxWidth) extraStyles['max-width'] = this.props.maxWidth;
        if (this.props.hidden) extraStyles = Object.assign({}, extraStyles, css.msgBox__hidden);

        let titleEl = null;
        if (this.props.title) {
            titleEl = (
                <h4 style={css.msgBox_title}>{this.props.title}</h4>
            )
        }

        let subtitleEl = null;
        if (this.props.subtitle) {
            subtitleEl = (
                <p style={css.msgBox_subtitle}>{this.props.subtitle}</p>
            )
        }

        let arrowEls = [];
        if (this.props.isCarousel) {
            arrowEls.push(<div style={Object.assign({}, css.msgBox_arrow, css.msgBox_arrow__left)} onClick={(e) => { this.props.onCarouselClick('back', e) }}><Icon iconName="arrow_drop_down_circle" width="2rem" /></div>);
            arrowEls.push(<div style={Object.assign({}, css.msgBox_arrow, css.msgBox_arrow__right)} onClick={(e) => { this.props.onCarouselClick('forward', e) }}><Icon iconName="arrow_drop_down_circle" width="2rem" /></div>);
        }

        return (
            <div style={Object.assign({}, css.msgBox, extraStyles)} className="msgBox">
                {titleEl}
                {subtitleEl}
                <div style={css.msgBox_body}>{this.props.body}</div>
                {arrowEls}
            </div>
        );
    }

}

export default Radium(MsgBox);
