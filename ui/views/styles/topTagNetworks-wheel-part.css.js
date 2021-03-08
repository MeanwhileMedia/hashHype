import _ from '/node_modules/underscore';
import d3 from '/node_modules/d3';
import Radium from '/node_modules/radium';

const styles = {

    generate(view) {
        //const colorPallette = d3.schemePastel1;
        const colorPallette = ["#f94144","#f3722c","#f8961e","#f9844a","#f9c74f","#90be6d","#43aa8b","#4d908e","#577590","#277da1"]; //https://coolors.co/palettes/trending
        let colorRank = view.props.data.rank;
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


        return {
            // '.wheel_part': {
            // },
            '.wheel_part_path': {
                stroke: '#fff',
                fill: colorPallette[colorRank],
                fillRule: 'evenodd',
            },
            '.wheel_part__grew': {
                animation: `x .2s ease ${grewFlashInterval}s ${view.state.wheelGrowthCount}`,
                animationName: grewFlash,
            },
        };

    }, // end generate

};

export default styles;
