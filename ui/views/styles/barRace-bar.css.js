import utils from '../../helpers/utils.js'

const styles = {

    generate(view) {
        const zBasedRank = view.state.topComment.rankRender - 1;
        const barColorPallette = ["#f94144","#f3722c","#f8961e","#f9844a","#f9c74f","#90be6d","#43aa8b","#4d908e","#577590","#277da1"]; //https://coolors.co/palettes/trending
        const barsUlEl = document.querySelector('.topCommentStats_barRace_bars');

        const barHeight = 7; //rem. used when setting abs top position on each bar
        const barSpaceBetween = .5; //rem
        const barWidthTransTime = 2 + 3*Math.random(); // topTagStats is currently set to refresh every 5s
        const barTopTransTime = .4 + .4*Math.random();

        const barWidth = view.state.topComment.totalPoints/view.state.maxPointsScale; // percentage width

        let barTextSize = view.state.barLabelMaxFontSize;
        if (barTextSize === Infinity) barTextSize = view.state.barLabelDefaultFontSize;

        let textWrapperEl_right = '1.5rem';
        let textWrapperEl_left = 'auto';
        let textWrapperEl_color = 'rgb(255, 255, 255)';
        if (view.state.renderTextOutside) {
            if (view.barTextElRef.current) {
                textWrapperEl_right = 'auto';
                textWrapperEl_left = '100%';
                textWrapperEl_color = 'rgba(0, 0, 0, 0.7)';
            }
        }

        const css = {

            topCommentStats_barRace_bar: {
                'position': 'absolute',
                'left': '0',
                'cursor': 'pointer',
                'top': `${(barHeight*zBasedRank)+(barSpaceBetween*zBasedRank)}rem`,
                'height': `${barHeight}rem`,
                'transition': `width ${barWidthTransTime}s ease, top ${barTopTransTime}s ease`,
                'width': `${barWidth*100}%`,
                'background-color': barColorPallette[zBasedRank]
            },
            topCommentStats_barRace_bar__active: {
                'border': '4px solid rgba(255, 255, 255, .6)',
                'border-left': '0',
                'border-right': '1.2rem solid rgba(255, 255, 255, .6)',
                'transition': 'border .2s ease, margin-top .2s ease',
                'margin-top': '-4px',
            },
            topCommentStats_barRace_bar_label: {
                'height': '100%',
                'width': '100%',
            },
            topCommentStats_barRace_bar__active_label: {
                'border-right': '0.24rem solid rgb(255, 255, 255)',
            },

            topCommentStats_barRace_bar_label_text_wrapper: {
                'font-size': barTextSize,
                'text-align': view.state.renderTextOutside ? 'left' : 'right',
                'width': view.state.barLabelMaxWidth,
                'position': 'absolute',
                'left': textWrapperEl_left,
                'right': textWrapperEl_right,
                'top': '1.2rem',
                'margin-left': '1.5rem',
                'transition': 'color .2s ease, right .2s ease',
                'color': textWrapperEl_color,
            },
            topCommentStats_barRace_bar_label_text: {
            },

        };

        return css;
    }, // end generate

};

export default styles;
