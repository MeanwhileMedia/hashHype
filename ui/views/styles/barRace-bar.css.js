import utils from '../../helpers/utils.js'

const styles = {

    generate(view) {

        const barHeight = 7; //rem. used when setting abs top position on each bar
        const barSpaceBetween = .5; //rem
        const barWidthTransTime = 2 + 3*Math.random(); // topTagStats is currently set to refresh every 5s
        const barTopTransTime = .4 + .4*Math.random();

        let textWrapperEl_right = '1.5rem';
        let textWrapperEl_color = 'rgb(255, 255, 255)';
        if (view.state.renderTextOutside) {
            if (view.barTextElRef.current) {
                textWrapperEl_right = ((view.barTextElRef.current.getBoundingClientRect().width + utils.curMagicScreenMeasure*1.5) * -1)+'px';
                textWrapperEl_color = 'rgba(0, 0, 0, 0.7)';
            }
        }

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
                'border-left': '0',
                'border-right': '1.2rem solid rgba(255, 255, 255, .6)',
                'transition': 'border .2s ease, margin-top .2s ease',
                'margin-top': '-4px',
            },
            topCommentStats_barRace_bar_label: {
                'font-size': '3.5rem',
                'text-align': 'right',
                'height': '100%',
            },
            topCommentStats_barRace_bar__active_label: {
                // 'transition': 'border .2s ease',
                'border-right': '0.24rem solid rgb(255, 255, 255)',
            },

            topCommentStats_barRace_bar_label_text: {
                'position': 'absolute',
                'right': textWrapperEl_right,
                'top': '1.4rem',
                'transition': 'color .2s ease, right .2s ease',
                'color': textWrapperEl_color,
            },

        };

        css.barHeight = barHeight;
        css.barSpaceBetween = barSpaceBetween;

        return css;
    }, // end generate

};

export default styles;
