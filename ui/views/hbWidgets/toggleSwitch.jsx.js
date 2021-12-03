import React from '/node_modules/react';
import Radium from '/node_modules/radium';

class ToggleSwitch extends React.Component {
    constructor(props) {
        super(props);
        this.color = this.props.color || 'light';
    }

    inputClickEvent(e) {
        // Always stop the click event from bubbling up from the input el. Clicks are controlled outside of this component.
        e.stopPropagation();
    }

    render() {
        return (
            <label class={`hbWidgets hbWidgets--small toggleSwitch toggleSwitch--${this.color}`}>
                <input type="checkbox" checked={this.props.checked} onClick={this.inputClickEvent}></input>
                <div><span></span></div>
            </label>
        );
    }
}

export default Radium(ToggleSwitch);
