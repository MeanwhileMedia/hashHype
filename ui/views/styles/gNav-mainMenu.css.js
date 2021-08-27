const styles = {

    generate(view) {

        const css = {
            GNavMainMenu: {
                'margin-left': '6rem',
                'font-size': '1.8rem',
                'text-align': 'left',
                'width': '11rem'
            },
            GNavMainMenu_li: {
                'position': 'relative',
                'font-weight': '100',
                'margin-bottom': '1rem',
                'color': 'rgb(255 255 255 / 60%)',
                'cursor': 'pointer',
                'transition': 'color 0.2s',
                'letter-spacing': '0.04rem',
                'white-space': 'nowrap',
                'user-select': 'none',
                ':hover': {
                    'font-weight': '400',
                    'color': 'rgb(255 255 255)',
                    'letter-spacing': '0',
                }
            },
            GNavMainMenu_ul__subsection: {
                'border-top': '1px solid rgb(255 255 255 / 30%)',
                'margin-top': '2rem',
                'padding-top': '1rem',
                'font-size': '1.6rem'
            },
            GNavMainMenu_li_icon: {
                'position': 'absolute',
                'top': '.1rem',
                'left': '-5rem',
                'transform': 'scale(0.6)'
            },
        };

        return css;
    }, // end generate

};

export default styles;
