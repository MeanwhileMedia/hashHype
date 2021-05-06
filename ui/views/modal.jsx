import React from '/node_modules/react';
import styles from './styles/modal.css.js';

class Modal extends React.Component {
    render() {
        if (!this.props.content) {
            console.log('Error: Modal must have content defined...');
            return null;
        }
        const thisView = this;
        const css = styles.generate(this);

        let body = this.props.content.body; // Defaults to expect a react child component
        if (typeof this.props.content.body === 'string') { // This modal also supports passing text HTML string
            body = (
                <div style={css.body} dangerouslySetInnerHTML={{ __html: this.props.content.body }} />
            );
        }
        return (
            <div className="Modal" style={css.modal} onClick={this.hideModal.bind(this)}>
                <h3 style={css.modal_heading}>{this.props.content.title}</h3>
                <div style={css.modal_body_outer}>
                    <div style={css.modal_body_inner} onClick={this.clickedChildContent.bind(this)}>
                        {body}
                    </div>
                </div>
            </div>
        );
    }

    hideModal(e) {
        this.props.modal.hide();
    }

    clickedChildContent(e) {
        e.stopPropagation(); // So clicks on child content doesn't close the modal
    }
}

export default Modal;
