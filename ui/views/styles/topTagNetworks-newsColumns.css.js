import _ from '/node_modules/underscore';

const styles = {

  generate(view) {
    const css = {
      newsColumns: {
        display: 'flex',
        'flex-direction': 'row',
        'justify-content': 'space-between',
        padding: '7vh 5%',
        height: '100%',
        'box-sizing': 'border-box',
      },
      newsColumns_left: {
        width: '30%',
      },
      newsColumns_left_author_h4: {
        'margin-top': '1rem',
      },
      newsColumns_right: {
        width: '30%',
        'padding-top': '14px',
        'text-align': 'right',
      },
      newsColumns_ctrls: {
          position: 'absolute',
          top: '1rem',
          right: '1rem'
      },
      newsAttribution: {
        'margin-top': '1.4rem',
        'text-decoration': 'none',
        color: 'inherit',
        'font-size': '1.4rem',
        display: 'inline-block',
      },
      newsAttributionAuth: {
        opacity: '.6',
      },
      newsAttributionTitle: {
        'font-weight': '600',
      },
    };

    return css;
  }, // end generate

};

export default styles;
