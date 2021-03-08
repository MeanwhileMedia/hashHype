const styles = {

  generate(view) {
    const css = {
      modal: {
        display: view.props.content.visible ? 'flex' : 'none',
        'text-align': 'center',
        'flex-direction': 'column',
        'justify-content': 'center',
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100vw',
        height: '100vh',
        'background-color': 'rgba(0, 0, 0, 0.75)',
        color: '#fff',
      },
      modal_heading: {
          'margin-bottom': '2rem'
      },
      body: {
        'font-size': '1.6rem',
        'line-height': '150%',
      },
      modal_body_outer: {
        'display': 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'overflow': 'auto'
      },
      modal_body_inner: {

      }
    };

    return css;
  }, // end generate

};

export default styles;
