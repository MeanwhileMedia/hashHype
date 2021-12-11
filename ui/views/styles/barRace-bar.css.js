const styles = {

    generate(view) {

        const barHeight = 7; //rem. used when setting abs top position on each bar
        const barSpaceBetween = .5; //rem
        const barWidthTransTime = 2 + 3*Math.random(); // topTagStats is currently set to refresh every 5s
        const barTopTransTime = .4 + .4*Math.random();

        const css = {

            topCommentStats_barRace_bar: {
                'position': 'absolute',
                'left': '0',
                'height': `${barHeight}rem`,
                'cursor': 'pointer',
                'transition': `width ${barWidthTransTime}s ease, top ${barTopTransTime}s ease`
            },
            topCommentStats_barRace_bar__active: {
                'border': '4px solid rgba(255, 255, 255, .6)',
                'margin-left': '-4px',
                'margin-top': '-4px',
            },
            topCommentStats_barRace_bar_activeArrow: {
                'width': '3rem',
                'height': '3rem',
                'transform': 'rotate(270deg)',
                'position': 'absolute',
                'left': '0',
                'top': '50%',
                'margin-top': '-1.5rem',
                'margin-left': '-1.5rem',
                'box-sizing': 'border-box'
            },
            topCommentStats_barRace_bar_label: {
                'position': 'absolute',
                'right': '1rem',
                'top': '1.4rem',
                'color': '#ffff',
                'font-size': '3.5rem',
                'text-align': 'right',
            }

        };

        css.barHeight = barHeight;
        css.barSpaceBetween = barSpaceBetween;

        return css;
    }, // end generate

};

export default styles;
