import _ from '/node_modules/underscore';

const styles = {

  generate(view) {
    const winWidth = window.outerWidth;
    const winHeight = window.outerHeight;
    const maxOuterRadius = winWidth * 1.2 / 2;
    const minOuterRadius = maxOuterRadius - Math.min(winHeight * 0.3, maxOuterRadius * 0.6);
    const percOverflow = (maxOuterRadius * 2 / winWidth * 100) - 100;
    const topPos = winHeight - (maxOuterRadius - minOuterRadius) - (maxOuterRadius * 0.1); // just a slice of the inner blank circle visible

    const css = {
      wheel: {
        position: 'fixed',
        top: `${topPos / winHeight * 100}vh`,
        left: `-${percOverflow / 2}%`,
        width: `${100 + percOverflow}%`,
        overflow: 'visible',
      },
      wheel_svg: {
        overflow: 'visible',
        transition: 'transform .2s ease-in-out',
      },
      wheel_panCatcher: {
        width: '100%',
        height: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
      },
    };

    css.maxOuterRadius = maxOuterRadius;
    css.minOuterRadius = minOuterRadius;
    return css;
  }, // end generate

};

export default styles;
