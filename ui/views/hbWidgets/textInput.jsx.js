import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import utils from '../../helpers/utils.js'

class TextInput extends React.Component {
    constructor(props) {
        super(props);
        const initialVal = this.determineVal(this.props.value || '', false);
        this.state = {
            value: initialVal,
            renderVal: this.determineRenderedVal(initialVal), //sometimes the rendered value will be different from computed value (like when we add the ordinal suffix)
            curSelection: null
        }
        this.contenteditableRef = React.createRef();
        this.hasFocus = false;

        if (props.type === 'keySet' && !props.keySetMap) {
            console.log(`Input of type "keySet" must include the props.keySetMap object. Reverting to default.`);
            props.type = 'default';
        }

         // props.placeholder - same as native input placeholder prop
         // props.preservePlaceholder - set to true and the placeholder text will not clear on focus

         // props.type can be:
         // - "ordinal" (and below code automatically applies the suffix as input changes)
         // - "keySet" (input changes based on specific rules set for specific keypress types - must be accompanied by the keySetMap prop)
         // - "default" to be any string input without code based formatting

         // props.keySetMap (must be defined when type === keySet)
         // {keyCode: (e) => { return 'valToBeRendered'}, etc ...}

         // props.size can be:
         // - "small" fo inline inputs inside body size text
         // - "large" for box type inputs full border, 100% width

         // props.textAlign
         // props.minWidth
         // props.ctaGutter - rem measurement. carves out space via bottom padding to float in cta buttons (for props.size = large)

    }

    componentDidUpdate(prevProps, prevState) {
        // Restore the carat into it's active position within text
        if (!this.state.curSelection) return;
        const editableEl = this.contenteditableRef.current;
        let inputtedTextNode = editableEl.childNodes[0];
        if (!inputtedTextNode) { // this will be undefined when the contenteditable is empty (backspaced OR placeholder text was just programatically cleared)
            inputtedTextNode = document.createTextNode('');
            editableEl.appendChild(inputtedTextNode);
        }
        if (inputtedTextNode.textContent !== this.state.renderVal) {
            // because of how react does conditional rendering against a virtual dom, these may become out of sync. Correct manually...
            inputtedTextNode.textContent = this.state.renderVal;
        }

        const range = document.createRange();
        const sel = document.getSelection();
        const focusOffset = Math.min(inputtedTextNode.length, this.state.curSelection.focusOffset);
        range.setStart(inputtedTextNode, focusOffset);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    onInputChange(e) {
        if (!e.target || !document.getSelection) return;
        if (this.props.type === 'keySet') { // the keySet type takes full control of what renders to the input
            e.target.innerText = this.state.renderVal;
            return;
        }
        const curSelection = document.getSelection();
        const newVal = this.determineVal(e.target.innerText);
        const focusOffset = curSelection.focusOffset;
        this.setState({
            value: newVal,
            renderVal: this.determineRenderedVal(newVal),
            curSelection: {focusOffset: focusOffset}
        });
    }

    onInputFocus(e) {
        this.hasFocus = true;
        if (!e.target) return;
        if (e.target.innerText === this.determineRenderedVal(this.props.placeholder) && !this.props.preservePlaceholder) {
            const curSelection = document.getSelection();
            const focusOffset = curSelection.focusOffset;
            // remove placeholder text now that user has focused
            this.setState({
                value: '',
                renderVal: '',
                curSelection: {focusOffset: 0}
            });
        }
        this.bindKeyboardCtrls();
    }

    onInputBlur(e) {
        // if the user left the input with no value, render the placeholder. Also set curSelection back to null.
        this.hasFocus = false;
        if (!e.target) return;
        const newVal = this.determineVal(e.target.innerText, false);
        this.setState({
            value: newVal,
            renderVal: this.determineRenderedVal(newVal),
            curSelection: null
        });
    }

    bindKeyboardCtrls() {
        const self = this;
        if (self.props.type !== 'keySet') return;

        for (const [thisKeyCode, thisValGenFunction] of Object.entries(self.props.keySetMap)) {
            const thisKeyboardCtrlsCback = (e) => {
                if (!self.hasFocus) return;
                const newVal = thisValGenFunction(e);
                self.setState({
                    value: newVal,
                    renderVal: self.determineRenderedVal(newVal),
                    curSelection: {focusOffset: 0}
                });
            }
            utils.registerKeyboardCtrlsListener(`inputKeyset${thisKeyCode}`, thisKeyboardCtrlsCback.bind(self), {
                keyCode: parseInt(thisKeyCode),
                ctrlKey: false,
                shiftKey: false
            });
        };
    }

    render() {
        const self = this;

        const addStyles = {};
        if (this.props.textAlign) addStyles['text-align'] = this.props.textAlign;
        if (this.props.minWidth) addStyles['min-width'] = this.props.minWidth;
        if (this.props.ctaGutter) {
            addStyles['padding-bottom'] = this.props.ctaGutter;
            addStyles['padding-right'] = `${parseInt(this.props.ctaGutter)*2}rem`;
        }

        let addClasses = '';
        if (this.state.value == this.props.placeholder) addClasses = addClasses + 'textInput__empty ';
        if (this.props.size) addClasses = addClasses + `textInput__${this.props.size} `;

        return (
            <span
                ref={this.contenteditableRef}
                class={`hbWidgets textInput ${addClasses}`}
                style={addStyles}
                contenteditable="true"
                onInput={(e) => self.onInputChange.call(self, e)}
                onBlur={(e) => self.onInputBlur.call(self, e)}
                onFocus={(e) => self.onInputFocus.call(self, e)}>{this.state.renderVal}</span>
        );
    }

    determineVal(val = '', emptyAllowed = true) {
        let correctedVal = val;
        if (!emptyAllowed && !correctedVal && correctedVal !== 0) correctedVal = this.props.placeholder;
        if (this.props.type === 'ordinal') {
            correctedVal = parseInt(correctedVal);
            if ( Number.isNaN(correctedVal) ) correctedVal = '';
        }
        return correctedVal;
    }

    determineRenderedVal(val = '') {
        let renderVal = val;
        if (this.props.type === 'ordinal' && val !== '') {
            renderVal = parseInt(renderVal);
            renderVal = this.getNumberOrdinal(renderVal);
        }
        return renderVal;
    }

    getNumberOrdinal(n) {
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }
}

export default Radium(TextInput);
