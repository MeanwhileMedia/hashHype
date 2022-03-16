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

            topCommentStats_empty: {
                'padding': '0 2rem',
                'text-align': 'center',
                'width': '100%',
                'box-sizing': 'border-box'
            }
        };

        if (view.state.pageIsReady) {
            css.topCommentStats.opacity = 1;
        }

        return css;
    }, // end generate

};

export default styles;
