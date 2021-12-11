const styles = {

    generate(view) {

        const css = {
            GNav: {
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
            },
            GNav_left: {
                'display': 'flex',
                'flex-direction': 'row',
                'cursor': 'pointer',
            },
            GNav_left_logo: {
                'height': 'min(2rem, 6vw)',
                'margin-right': '0.5rem',
                'margin-top': '0.4rem',
            },
            GNav_left_name: {
                'font-size': 'min(2rem, 6vw)',
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
                'margin-left': '0.6rem'
            },
            GNav_closeModalBtn: {
                'margin-right': '2rem'
            },
            GNav_bottom_right: {
                'position': 'fixed',
                'right': '0',
                'bottom': '0',
                'margin': '1rem'
            },
            GNav_bottom_right_ctrls: {

            },
            GNav_bottom_right_ctrls_vizCtrl: {
                'display': 'flex', // is magicScaled
                'align-items': 'center',
            },
            GNav_bottom_right_ctrls_vizCtrl_toggle: {
                'display': 'inline-block', // is magicScale
                'margin-left': '1rem',
                'margin-right': '0.8rem'
            },
            GNav_bottom_right_ctrls_vizCtrl_icon__leaderboard: {
                'display': 'inline-block',
                'transform': 'rotate(90deg) translateX(-2px)'
            },

            GNav_theme__light: {
                'color': '#fff',
                'border-bottom': 'none'
            },

            GNav_section_about_body: {
                // 'font-size': '2rem'
            },
            GNav_section_about_tech: {
                // 'font-size': '1.4rem',
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
