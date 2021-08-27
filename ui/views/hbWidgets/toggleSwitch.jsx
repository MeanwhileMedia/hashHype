import React from '/node_modules/react';
import Radium from '/node_modules/radium';

class ToggleSwitch extends React.Component {
    constructor(props) {
        super(props);
    }

    render() {
        return (
            <label class="hbWidgets hbWidgets--small toggleSwitch">
                <input type="checkbox" checked={this.props.checked}></input>
                <div><span></span></div>    
            </label>
        );
    }
}

export default Radium(ToggleSwitch);
