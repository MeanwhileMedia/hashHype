const styles = {

    generate(view) {

        const barHeight = 7; //rem. used when setting abs top position on each bar
        const barSpaceBetween = .5; //rem

        const css = {
            topCommentStats_barRace: {

            },
            topCommentStats_barRace_bars: {
                'width': '50%',
                'position': 'relative'
            },
            topCommentStats_barRace_bar: {
                'position': 'absolute',
                'left': '0',
                'height': `${barHeight}rem`,
                'cursor': 'pointer'
            },
            topCommentStats_barRace_bar__active: {
                'border': '1px solid #000'
            },
            topCommentStats_barRace_bar_label: {
                'position': 'absolute',
                'right': '1rem',
                'top': '1.4rem',
                'color': '#ffff',
                'font-size': '3.5rem',
                'text-align': 'right'
            }
        };

        css.barHeight = barHeight;
        css.barSpaceBetween = barSpaceBetween;

        return css;
    }, // end generate

};

export default styles;
