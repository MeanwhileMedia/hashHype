const styles = {

    generate(view) {
        // Gnav is a fixed size and all rules are defined in px
        const css = {
            GNavMainMenu: {
                'margin-left': 'min(5rem, 13vw)',
                'text-align': 'left',
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
                'width': '5rem',
                'overflow': 'visible',
            },
            GNavMainMenu_section_title: {
                'font-size': 'min(2rem, 6vw)',
            },
            GNavMainMenu_subsection_title: {
                'font-size': 'min(1.4rem, 4vw)',
            },
            GNavMainMenu_li_icon: {
                'display': 'flex',
                'flex-direction': 'row',
                'align-items': 'center',
                'position': 'absolute',
                'top': '0.7rem',
                'right': '100%',
                'margin-right': '.2rem',
                'transform-origin': 'right top',
            },
        };

        return css;
    }, // end generate

};

export default styles;
