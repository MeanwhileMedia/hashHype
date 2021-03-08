const styles = {

    generate(view) {
        const css = {
            adminTrain: {
                'display': 'flex',
                'flex-direction': 'column',
                'align-items': 'center',
                'padding-bottom': '4rem'
            },
            adminTrain_section: {
                'width': '30vw',
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
            }
        };

        return css;
    }, // end generate

};

export default styles;
