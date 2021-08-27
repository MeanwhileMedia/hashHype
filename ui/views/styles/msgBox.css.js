import Radium from '/node_modules/radium';

const styles = {

    generate(view) {
        const css = {
            msgBox: {
                'background-color': 'rgba(255, 247, 151, 25%)',
                'border-radius': '1rem',
                'padding': '2rem',
                'margin': '2rem auto',
                'margin-top': '0'
            },
            msgBox_title: {
                'margin-bottom': '0.5rem'
            },
            msgBox_subtitle: {
                'margin-top': '0',
                'margin-bottom': '3rem'
            },
            msgBox_body: {

            },
        };

        if (view.props.getAttn) {
            const attnPulse = Radium.keyframes({
              '70%': {
                'transform': `scale(1.008)`,
                'background-color': 'rgba(255, 247, 151, 30%)',
              },
            }, 'pulse');
            css.msgBox.animation = `x .2s ease .2s 3`;
            css.msgBox.animationName = attnPulse;
        }

        return css;
    }, // end generate

};

export default styles;
