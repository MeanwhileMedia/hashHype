import React from '/node_modules/react';
import Radium from '/node_modules/radium';

class Tooltip extends React.Component {
    // constructor(props) {
    //     super(props);
    //     this.state = {
    //         options: [...this.props.options]
    //     };
    // }

    render() {
        let addClasses = '';

        let icon = null;
        if (this.props.icon) {
            icon = (
                <span class="tooltip_icon material-icons">{this.props.icon}</span>
            );
        }

        return (
            <span class={`hbWidgets tooltip ${addClasses}`} onClick={this.props.onClick}>
                {icon}
                <span>{this.props.label}</span>
            </span>
        );
    }
}

export default Radium(Tooltip);
