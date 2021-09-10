import d3 from '/node_modules/d3';
import Radium from '/node_modules/radium';
import utils from '../../helpers/utils.js'

const styles = {

    generate(view) {
        //const colorPallette = d3.schemePastel1;
        const colorPallette = ["#f94144","#f3722c","#f8961e","#f9844a","#f9c74f","#90be6d","#43aa8b","#4d908e","#577590","#277da1"]; //https://coolors.co/palettes/trending
        let colorRank = view.props.data.rank - 1;
        if (view.props.allMsgCounts.length > colorPallette.length) {
            colorRank = Math.round((view.props.data.rank / view.props.allMsgCounts.length) * colorPallette.length);
        }

        const grewFlash = Radium.keyframes({
          '70%': {
            transform: `scale(1.00${Math.ceil(Math.random() * 100)})`,
            opacity: `${0.6 + 0.4 * Math.random()}`,
          },
        }, 'pulse');

        const viewRefreshRate = 2; // (s) try to keep in sync with hbKoa.socketEventThrottle. Hardcoded for now.
        const grewFlashInterval = viewRefreshRate / Math.min(view.state.wheelGrowthCount, 10);

        // because our SVG viewport scales, our text elements don't show our true rem scaling. Our wheel has it's
        // own static font-size which is based on the scaled magicScreenMeasure.

        return {
            'wheel_part': {
                'font-size': `${Math.max(utils.curMagicScreenMeasure*.9, 10)}px`,
                '@media only screen and (max-width: 1024px)': {
                    'font-size': `${Math.max(utils.curMagicScreenMeasure*.4, 6)}px`,
                },
            },
            'wheel_part_path': {
                'stroke': '#fff',
                'fill': colorPallette[colorRank],
                'fillRule': 'evenodd',
            },
            'wheel_part_title': {
                'opacity': 0,
                'transition': 'opacity .4s ease-in'
            },
            'wheel_part_title_label': {
                'opacity': 0,
                'fill': '#b3b3b3',
                'transition': 'opacity .2s ease-in .2s',
            },
            'wheel_part_title__symbol': {
                'opacity': 0.2
            },
            'wheel_part_title__rank': {
                'opacity': 0
            },
            'wheel_part_buttons': {
                'margin-top': '2.4em',
                'text-align': 'center',
                'opacity': 0,
                'transition': 'opacity .2s ease-in .4s'
            },
            'wheel_part_anchor': { // for getting accurate wheel part position readings using getBoundingClientRect
                'width': '1px',
                'height': '1px',
                'margin': '0 auto',
            },
            'wheel_part__grew': {
                'animation': `x .2s ease ${grewFlashInterval}s ${view.state.wheelGrowthCount}`,
                'animationName': grewFlash,
            },

        };

    }, // end generate

};

export default styles;
