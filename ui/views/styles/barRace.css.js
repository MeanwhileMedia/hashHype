const styles = {

    generate(view) {

        const barHeight = 7; //rem. used when setting height of the bar container (bars are absolute). MAKE SURE this is in sync with var of same name in barRace-bar.css.js
        const barContainerHeight = barHeight * view.state.topCommentCount;

        const css = {
            topCommentStats_barRace: {
            },

            topCommentStats_barRace_bars: {
                'width': '50%',
                'height': `${barContainerHeight}rem`,
                'position': 'relative'
            },

            topCommentStats_barRace_activeCommentInfo: {
                'position': 'fixed',
                'top': '0',
                'bottom': '0',
                'padding-top': '7rem',
                'overflow-y': 'scroll',
                'text-align': 'right',
                'box-sizing': 'border-box',
                'width': '55%',
                'padding-left': '2rem',
                'margin-left': '50%',
                'padding-right': '6%',
            },
            topCommentStats_barRace_activeCommentInfo_symbolTitle: {
                'margin-bottom': '4rem',
            },
            topCommentStats_barRace_activeCommentInfo_bodyText: {
                'line-height': '168%'
            },
            topCommentStats_barRace_activeCommentInfo_btns: {
                'display': 'flex',
                'flex-direction': 'row-reverse',
                'align-items': 'center',
                'margin-top': '3rem',
                'margin-bottom': '6rem'
            },
            topCommentStats_barRace_activeCommentInfo_infoBtn: {
                'height': '2rem',
                'display': 'inline-flex',
                'margin-left': '0.5rem'
            },
            topCommentStats_barRace_activeCommentInfo_actionBtn: {
                'display': 'inline-flex'
            }
        };

        return css;
    }, // end generate

};

export default styles;
