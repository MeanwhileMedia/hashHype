const styles = {

    generate(view) {

        const css = {
            topCommentStats_barRace: {
                'flex-direction': 'row',
                'display': 'flex'
            },

            topCommentStats_barRace_bars: {
                'width': '50%',
                'position': 'relative'
            },

            topCommentStats_barRace_activeCommentInfo: {
                'width': '50%',
                'text-align': 'right',
                'padding-left': '5rem',
                'padding-right': '2rem'
            },
            topCommentStats_barRace_activeCommentInfo_symbolTitle: {
                'margin-bottom': '4rem',
            },
            topCommentStats_barRace_activeCommentInfo_bodyText: {

            },
            topCommentStats_barRace_activeCommentInfo_author: {
                'font-weight': '400',
                'font-style': 'italic',
                'margin-top': '2rem',
                'padding-top': '0.5rem',
                'display': 'inline-block',
                'border-top': '1px solid rgba(0,0,0,0.15)',
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
