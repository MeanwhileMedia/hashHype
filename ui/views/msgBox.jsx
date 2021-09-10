import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import styles from './styles/msgBox.css.js';

class MsgBox extends React.Component {
    // constructor(props) {
    //     super(props);
    // }

    render() {
        const css = styles.generate(this);

        const extraStyles = {};
        if (this.props.maxWidth) extraStyles['max-width'] = this.props.maxWidth;

        return (
            <div style={Object.assign({}, css.msgBox, extraStyles)} className="msgBox">
                <h4 style={css.msgBox_title}>{this.props.title}</h4>
                <p style={css.msgBox_subtitle}>{this.props.subtitle}</p>
                <div style={css.msgBox_body}>{this.props.body}</div>
            </div>
        );
    }

}

export default Radium(MsgBox);
