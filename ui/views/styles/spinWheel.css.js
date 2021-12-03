
const styles = {

    generate(view) {
        const winWidth = window.outerWidth;
        const winHeight = window.outerHeight;
        const maxOuterRadius = winWidth * 1.2 / 2;
        const minOuterRadius = maxOuterRadius - Math.min(winHeight * 0.3, maxOuterRadius * 0.6);
        const percOverflow = (maxOuterRadius * 2 / winWidth * 100) - 100;
        let topPos = winHeight - (maxOuterRadius - minOuterRadius); // first position to be perfectly aligned at bottom
        topPos = topPos - ((winHeight/winWidth) * 60); // then move slightly up base on screen ratio. It moves higher on portrait size screens.

        const css = {
            wheel: {
                'position': 'fixed',
                'top': `${topPos / winHeight * 100}vh`,
                'left': `-${percOverflow / 2}%`,
                'width': `${100 + percOverflow}%`,
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

        if (view.wheelShouldAutoRotate && view.didAutoRotateToStart) {
            // upon pageload wheel rotates very slowly to intro motion. looks much better with transition
            css.wheel.transition = 'transform .2s';
        }

        css.maxOuterRadius = maxOuterRadius;
        css.minOuterRadius = minOuterRadius;
        return css;
    }, // end generate

};

export default styles;
