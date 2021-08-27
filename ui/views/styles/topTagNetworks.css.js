const styles = {

  generate(view) {
    const css = {
      topTags: {
        'height': '100%',
        'opacity': '0',
        'transition': 'opacity .2s'
      },
    };

    if (view.state.pageIsReady) {
        css.topTags.opacity = 1;
    }

    return css;
  }, // end generate

};

export default styles;
