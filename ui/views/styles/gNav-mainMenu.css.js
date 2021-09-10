const styles = {

    generate(view) {
        // Gnav is a fixed size and all rules are defined in px
        const css = {
            GNavMainMenu: {
                'margin-left': '60px',
                'font-size': 'max(1.6rem, 16px)',
                'text-align': 'left',
                'width': '110px'
            },
            GNavMainMenu_li: {
                'position': 'relative',
                'font-weight': '100',
                'margin-bottom': '10px',
                'color': 'rgb(255 255 255 / 60%)',
                'cursor': 'pointer',
                'transition': 'color 0.2s',
                'letter-spacing': '.5px',
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
                'margin-top': '20px',
                'padding-top': '10px',
                'font-size': 'max(1.2rem, 12px)',
            },
            GNavMainMenu_li_icon: {
                'display': 'flex',
                'flex-direction': 'row',
                'align-items': 'center',
                'height': '100%',
                'position': 'absolute',
                'top': '1px',
                'left': '-50px',
                'transform': 'scale(0.6)'
            },
        };

        return css;
    }, // end generate

};

export default styles;
