import utils from '../../helpers/utils.js'

const styles = {

    generate(view) {
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;

        let embiggen, maxOuterRadius, minOuterRadius, bottomPos;
        if (winWidth / winHeight > 0.7) { // landscape
            embiggen = 0.8;
        } else { // portrait
            embiggen = 1.2;
        }
        maxOuterRadius = (winWidth * embiggen) / 2;
        minOuterRadius = maxOuterRadius * 0.6;

        bottomPos = maxOuterRadius * -1;
        if (maxOuterRadius > winHeight / 2) {
            bottomPos = (maxOuterRadius * 1.4) * -1;
        }

        const css = {
            wheel: {
                'position': 'fixed',
                'bottom': `${bottomPos}px`,
                'left': `50vw`,
                'width': `${maxOuterRadius * 2}px`,
                'margin-left': `-${maxOuterRadius}px`,
                'overflow': 'visible',
                '-webkit-font-smoothing': 'subpixel-antialiased'
            },
            wheel_svg: {
                'overflow': 'visible',
                'transition': 'transform .2s ease-in-out',
            },
            wheel_panCatcher: {
                'width': '100%',
                'height': '100%',
                'position': 'absolute',
                'border-radius': '50%',
                'top': 0,
                'left': 0,
                'cursor': 'ew-resize'
            },
        };

        // css.wheelRotateTransition = 'transform 10s';
        // if (view.cssTransitionRotate) {
        //     // upon pageload wheel rotates very slowly to intro motion. looks much better with transition
        //     css.wheel.transition = css.wheelRotateTransition;
        // }

        css.maxOuterRadius = maxOuterRadius;
        css.minOuterRadius = minOuterRadius;
        return css;
    }, // end generate

};

export default styles;
