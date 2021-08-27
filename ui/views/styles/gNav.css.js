const styles = {

    generate(view) {
        const css = {
            GNav: {
                'display': 'flex',
                'flex-direction': 'row',
                'justify-content': 'space-between',
                'padding': '1rem 2rem',
                'position': 'fixed',
                'top': '0',
                'left': '0',
                'width': '100vw',
                'box-sizing': 'border-box',
                'border-bottom': '1px solid rgb(0 0 0 / 5%)'
            },
            GNav_left: {
                'display': 'flex',
                'flex-direction': 'row',
                'cursor': 'pointer',
            },
            GNav_left_logo: {
                'height': '2rem',
                'margin-right': '.8rem',
                'margin-top': '.55rem'
            },
            GNav_left_name: {
                'font-size': '2rem',
                'padding-top': '.2rem'
            },
            GNav_right: {
                'display': 'flex',
                'flex-direction': 'row'
            },
            GNav_right_ctrls: {
                'display': 'flex',
                'flex-direction': 'row',
                'align-items': 'center'
            },
            GNav_right_ctrls_icon: {
                'margin-left': '.6rem'
            },

            GNav_theme__light: {
                'color': '#fff',
                'border-bottom': 'none'
            },

            GNav_section_about_body: {
                'font-size': '2rem'
            },
            GNav_section_about_tech: {
                'font-size': '1.4rem',
                'border-top': '1px solid #777',
                'padding-top': '1rem',
                'margin-top': '2rem',
                'margin-bottom': '3rem'
            }
        };

        return css;
    }, // end generate

};

export default styles;
