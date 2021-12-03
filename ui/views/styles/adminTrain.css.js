const styles = {

    generate(view) {

        const adminTrain_section_code_presentation = {
            'display': 'inline-block',
            'width': '100%',
            'box-sizing': 'border-box',
            'min-height': '8rem',
            'border': '1px solid #fff',
            'border-radius': '4px',
            'font-size': 'max(1.4rem, 12px)',
            'padding': '1rem',
            'padding-bottom': '4rem',
            'outline': 'none',
            'background-color': 'rgba(0,0,0,.25)',
            'white-space': 'pre-wrap'
        };

        const css = {
            adminTrain: {
                'display': 'flex',
                'flex-direction': 'column',
                'align-items': 'center',
            },
            adminTrain_section: {
                'width': '100%',
                'text-align': 'left',
                'margin-bottom': '2rem'
            },
            adminTrain_section_rows: {
                'display': 'flex',
                'flex-direction': 'row',
                'align-items': 'center',
                'justify-content': 'space-between'
            },
            adminTrain_section_rows_ctrls: {
                'margin-left': '2rem'
            },
            adminTrain_section_code: {
                'position': 'relative',
                'margin': '1.4rem 0',
                'display': 'none'
            },
            adminTrain_section_code_presentation: Object.assign({...adminTrain_section_code_presentation}, {
                'position': 'absolute',
                'pointer-events': 'none'
            }),
            adminTrain_section_code_input: Object.assign({...adminTrain_section_code_presentation}, {
                'color': 'transparent',
                'caret-color': '#fff',
                'background-color': 'transparent'
            }),
            adminTrain_section_code_buttons: {
                'position': 'absolute',
                'right': '1rem',
                'bottom': '2rem'
            }
        };

        return css;
    }, // end generate

};

export default styles;
