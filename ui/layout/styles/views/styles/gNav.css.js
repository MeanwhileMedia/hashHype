const styles = {

    generate(view) {
        // Gnav is a fixed size and all rules are defined in px
        const css = {
            GNav: {
                'font-size': 'calc(1vmax / 1vmin * 10px)', // gnav maintains it's own scaling zone. All children to gnav should use em units
                'display': 'flex',
                'flex-direction': 'row',
                'justify-content': 'space-between',
                'padding': '10px 20px',
                'position': 'fixed',
                'top': '0',
                'left': '0',
                'width': '100vw',
                'box-sizing': 'border-box',
                'border-bottom': '1px solid rgb(0 0 0 / 5%)',
                // '@media only screen and (max-width: 1024px)': {
                //     'font-size': '8px'
                // },
                // '@media only screen and (max-width: 768px)': {
                //     'font-size': '6px'
                // },
                // '@media only screen and (max-width: 1024px) and (min-resolution: 2dppx) and (orientation: portrait)': { // stopping - min-resolution rule is overlapping between 4k screen and commone device resolutions.
                //     'font-size': '18px'
                // },
            },
            GNav_left: {
                'display': 'flex',
                'flex-direction': 'row',
                'cursor': 'pointer',
            },
            GNav_left_logo: {
                'height': '2em',
                'margin-right': '0.8em',
                'margin-top': '0.75em'
            },
            GNav_left_name: {
                'font-size': '2em',
                'padding-top': '0.2em'
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
                'margin-left': '0.6em'
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
