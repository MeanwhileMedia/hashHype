
const styles = {

    generate(view) {
        const css = {
            newsColumns: {
                'display': 'flex',
                'flex-direction': 'row',
                'justify-content': 'space-between',
                'padding': '12vh 5vw',
                'padding-top': '0',
                'box-sizing': 'border-box',
            },
            newsColumns_left: {
                'width': '40vw',
                'word-break': 'break-word',
            },
            newsColumns_left_author: {
                'margin-top': '1rem',
            },
            newsColumns_right: {
                'width': '40vw',
                'word-break': 'break-word',
                'text-align': 'right',
            },
            newsColumns_right_author: {
                'font-weight': '400',
                'font-style': 'italic',
                'margin-top': '2rem',
                'padding-top': '0.5rem',
                'display': 'inline-block',
                'font-size': '1.4rem'
            },
            newsAttribution: {
                'margin-top': '1.4rem',
                'text-decoration': 'none',
                'color': 'inherit',
                'font-size': 'max(1.4rem, 12px)',
                'display': 'inline-block',
            },
            newsAttributionAuth: {
                'opacity': '.6',
            },
            newsAttributionTitle: {
                'font-weight': '600',
            },
        };

        return css;
    }, // end generate

};

export default styles;
