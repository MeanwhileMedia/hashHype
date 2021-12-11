const styles = {

    generate(view) {
        const css = {

            topCommentStats: {
                'min-height': '100vh',
                'opacity': '0',
                'padding': '7rem 0px',
                'width': '100vw',
                'box-sizing': 'border-box',
                'overflow-x': 'hidden'
            },

            topCommentStats_loadSpinner: {
                'display': 'block',
                'position': 'fixed',
                'top': '50%',
                'left': '50%',
                'margin-left': '-40px',
                'margin-top': '-80px',
                'opacity': '0.2'
            }

        };

        if (view.state.pageIsReady) {
            css.topCommentStats.opacity = 1;
            css.topCommentStats_loadSpinner.display = 'none';
        }

        return css;
    }, // end generate

};

export default styles;
