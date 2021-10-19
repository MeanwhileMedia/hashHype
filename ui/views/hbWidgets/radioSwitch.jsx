import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import utils from '../../helpers/utils.js'

class RadioSwitch extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            options: [...this.props.options]
        };
    }

    componentDidMount() {
        utils.setMagicScaleElements();
    }

    clickedRadioOption(e) {
        if (!e.currentTarget || !e.currentTarget.querySelector('label')) return;
        const clickedOptionLabel = e.currentTarget.querySelector('label').innerText;
        this.state.options.forEach((radioOption) => {
            if (radioOption.label === clickedOptionLabel) {
                radioOption.checked = true;
            } else {
                radioOption.checked = false;
            }
        });
        this.setState({
            options: [...this.props.options]
        });
    }

    render() {
        const self = this;
        if (!this.state.options || !this.state.options.length) return;

        // check the first one by default if none have checked state
        let hasCheckedState = false;
        this.state.options.forEach((radioOption) => {
            if (radioOption.checked) hasCheckedState = true;
        });
        if (!hasCheckedState) this.state.options[0].checked = true;

        const radioOptions = [];
        this.state.options.forEach((radioOption) => {
            const isChecked = radioOption.checked || false;
            radioOptions.push(
                <span class="hbWidgets radioSwitch" onClick={(e) => self.clickedRadioOption.call(self, e)}>
                    <input type="radio" id={radioOption.label} name="radio-group" checked={isChecked} />
                    <label for={radioOption.label}> {radioOption.label}</label>
                    <span>{radioOption.label}</span>
                </span>
            );
        });

        return (
            <span>{radioOptions}</span>
        );
    }
}

export default Radium(RadioSwitch);
