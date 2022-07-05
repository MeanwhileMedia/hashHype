import utils from '../../helpers/utils.js'

const styles = {

    generate(view) {

        const css = {

            topCommentBodyAndPoints_h5: {
                'width': '100%',
                'overflow-wrap': 'break-word'
            },

            topCommentBodyAndPoints_bodyLayers: {
                'position': 'relative',
                'line-height': '168%'
            },

            topCommentBodyAndPoints_bodyLayer: {
                'position': 'absolute',
                'top': '0',
                'left': '0',
                'width': '100%',
                'color': 'rgba(0,0,0,0)',
                'z-index': '-1',
            },

            topCommentBodyAndPoints_bodyLayer__primary: { // sits on top of all other bodyLayers - does not have any highlighting/special formatting applied
                'display': 'inline-block',
                'width': '100%'
            },

            topCommentBodyAndPoints_pointsInfo: {
                'margin-top': '2rem'
            },

            topCommentBodyAndPoints_pointsInfo_body: {
                'line-height': '156%'
            },

            topCommentBodyAndPoints_author: {
                'font-weight': '400',
                'font-style': 'italic',
                'margin-top': '1rem',
                'display': 'inline-block',
                'font-size': '1.4rem'
            },

        };

        return css;
    }, // end generate

};

export default styles;
