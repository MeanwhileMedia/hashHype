import React from '/node_modules/react';
import styles from './styles/topTagNetworks-adminTrain.css';

class AdminTrainRow extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            showDeletePrompt: false
        }
    }

    render() {
        const thisView = this;
        const css = styles.generate(this);

        const showDeletePrompt = this.state.showDeletePrompt;
        return (
            <div className='adminTrain_section_rows' style={css.adminTrain_section_rows}>
                <div style={{width: '100%'}}>
                    {showDeletePrompt ? this.props.deletePrompt : this.props.label}
                </div>
                <div className='adminTrain_section_rows_editIcon' style={css.adminTrain_section_rows_ctrls}>
                    <span class="material-icons" onClick={this.toggleDeletePrompt.bind(this)}>{this.props.editIcon}</span>
                </div>
            </div>
        );
    }

    toggleDeletePrompt(e) {
        this.setState({showDeletePrompt: !this.state.showDeletePrompt});
    }
    hideDeletePrompt(e) {
        this.setState({showDeletePrompt: false});
    }

}

export default AdminTrainRow;
