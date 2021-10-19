const styles = {

    generate(view) {

        let modalPaddingTop = '8rem';
        const gNavEl = document.querySelector('.GNav');
        if (gNavEl) {
            modalPaddingTop = gNavEl.getBoundingClientRect().height + 10 + 'px';
        }

        const css = {
            modal: {
                'display': view.props.content.visible ? 'flex' : 'none',
                'text-align': 'center',
                'flex-direction': 'column',
                'position': 'fixed',
                'top': '0',
                'left': '0',
                'width': '100vw',
                'height': '100vh',
                'background-color': 'rgba(0, 0, 0, 0.85)',
                'color': '#fff',
                'white-space': 'pre-wrap',
                'overflow-x': 'hidden',
                'overflow-y': 'auto',
                'padding': '40px 0',
                'padding-top': modalPaddingTop,
                'box-sizing': 'border-box'
            },
            // Alignment "classes" can be applied to any element class by appending a common a modifier. Only the "align__left" is passed in js during modal instantiation.
            modal__align__left: {
                'flex-direction': 'row'
            },
            modal__align__center: {
                'padding-left': '25vw',
                'padding-right': '25vw',
                '@media (max-width: 1024px)': {
                    'padding-left': '2vw',
                    'padding-right': '2vw'
                },
            },
            modal__align_text__left: {
                'text-align': 'left'
            },

            modal_inner: {
                'margin': 'auto 0'
            },
            // Alignment "classes" can be applied to any element class by appending a common a modifier. Only the "align__left" is passed in js during modal instantiation.
            modal_inner__align__top: {
                'margin': '0'
            },

            modal_title: {
                'margin-bottom': '3rem',
            },
            modal_subtitle: {
                'margin': '0',
                'margin-top': '-3rem',
                'margin-bottom': '3rem',
            },
            modal_body: {
                'line-height': '150%',
                'width': '100%'
            },
            modal_body_outer: {
                'display': 'flex',
                'flex-direction': 'column',
                'align-items': 'center',
                'box-sizing': 'border-box',
                'width': '100%'
            },
            modal_body_inner: {
                'width': '100%'
            }
        };

        return css;
    }, // end generate

};

export default styles;
