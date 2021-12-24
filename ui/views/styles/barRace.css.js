const styles = {

    generate(view) {

        const css = {
            topCommentStats_barRace: {
            },

            topCommentStats_barRace_bars: {
                'width': '50%',
                'position': 'relative'
            },

            topCommentStats_barRace_activeCommentInfo: {
                'box-sizing': 'border-box',
                'width': '50%',
                'text-align': 'right',
                'padding-left': '4rem',
                'padding-right': '3rem',
                'position': 'fixed',
                'right': '0',
            },
            topCommentStats_barRace_activeCommentInfo_symbolTitle: {
                'margin-bottom': '4rem',
            },
            topCommentStats_barRace_activeCommentInfo_bodyText: {
                'line-height': '168%'
            },
            topCommentStats_barRace_activeCommentInfo_author: {
                'font-weight': '400',
                'font-style': 'italic',
                'margin-top': '2rem',
                'padding-top': '0.5rem',
                'display': 'inline-block',
                // 'border-top': '1px solid rgba(0,0,0,0.15)',
                'font-size': '1.4rem'
            },
            topCommentStats_barRace_activeCommentInfo_actionBtn: {
                'margin-top': '4rem'
            }
        };

        return css;
    }, // end generate

};

export default styles;
