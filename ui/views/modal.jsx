import React from '/node_modules/react';
import Radium from '/node_modules/radium';
import styles from './styles/modal.css.js';

class Modal extends React.Component {
    constructor(props) {
        super(props);
    }

    render() {
        if (!this.props.content) {
            console.log('Error: Modal must have content defined...');
            return null;
        }
        const thisView = this;
        const css = styles.generate(this);

        let modalStyles = css.modal;
        let modalInnerStyles = css.modal_inner;
        const customStyleClasses = this.props.content.customStyleClasses || [];
        customStyleClasses.forEach((thisClass) => {
            if (css[`modal__${thisClass}`]) modalStyles = Object.assign(modalStyles, css[`modal__${thisClass}`]);
            if (css[`modal_inner__${thisClass}`]) modalInnerStyles = Object.assign(modalInnerStyles, css[`modal_inner__${thisClass}`]);
        });

        let body = this.props.content.body; // Defaults to expect a react child component
        if (typeof this.props.content.body === 'string') { // This modal also supports passing text HTML string
            body = (
                <div style={css.modal_body} dangerouslySetInnerHTML={{ __html: this.props.content.body }} />
            );
        }
        return (
            <div className="Modal" style={modalStyles} onClick={this.hideModal.bind(this)}>
                <div style={css.modal_inner}>
                    {this.props.content.title &&
                        <h3 style={css.modal_title}>{this.props.content.title}</h3>
                    }
                    {this.props.content.subtitle &&
                        <p style={css.modal_subtitle}>{this.props.content.subtitle}</p>
                    }
                    <div style={css.modal_body_outer}>
                        <div style={css.modal_body_inner} onClick={this.clickedChildContent.bind(this)}>
                            {body}
                        </div>
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

export default Radium(Modal);
