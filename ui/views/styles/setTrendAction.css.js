const styles = {

    generate(view) {

        // Because our JSX uses dynamic CSS logic there may be class__modifiers referenced which
        // don't actually have any specific styles. This would result in an undefined error while
        // using Object.assign (see view code). To fix, we add the following modifiers to every single
        // class created below in the css object.
        const applyModifiersToAllClasses = [
            'Robinhood',
            'Coinbase',
            'Twitter',
            'Email'
        ];

        const css = {
            setTrendAction: {
                'display': 'flex',
                'flex-direction': 'column',
                'align-items': 'center',
                'width': '100%'
            },
            setTrendAction_section: {
                'width': '100%',
                'margin-bottom': 'max(2rem, 20px)',
                'font-size': 'max(1rem, 12px)'
            },
            setTrendAction_section__inviteForm: {
                'margin-top': '2rem'
            },
            setTrendAction_thirdApps: {
                'width': '100%',
                'display': 'flex',
                'flex-direction': 'column',
                'align-items': 'center'
            },
            setTrendAction_thirdApps_icons: {
                'display': 'flex',
                'flex-direction': 'row',
                // 'max-width': '54rem'
            },
            setTrendAction_thirdApps_icon: {
                'display': 'inline-block',
                'width': '25%',
                'padding': '0 1rem',
                'box-sizing': 'border-box',
                'cursor': 'pointer'
            },
            setTrendAction_thirdApps_icon_img: {
                'width': '100%',
                'box-sizing': 'border-box',
                'border-radius': '15%',
                'opacity': '.9',
                ':hover': {
                    'opacity': '1'
                }
            },
            setTrendAction_thirdApps_icon_label: {
                'margin': '1rem 0',
                'border': 'none',
                'display': 'none'
            },
            setTrendAction_thirdAppsActionForm: {
                // 'max-width': '52rem',
                'margin': '0 auto',
                'white-space': 'nowrap'
            },
            setTrendAction_thirdAppsActionForm_save: {
                'margin-left': '2rem'
            },
            setTrendAction_thirdAppsActionForm_ctaSection: {
                'text-align': 'right',
                'margin-top': '-3.6rem',
                'padding-right': '1rem'
            }
        };

        // Assign all the class modifiers for our dynamic css logic
        Object.keys(css).forEach((thisClass) => {
            applyModifiersToAllClasses.forEach((thisClassMod) => {
                css[`${thisClass}__${thisClassMod}`] = css[`${thisClass}__${thisClassMod}`] || {};
            });
        });

        if (view.state.activeThirdApp) {
            css[`setTrendAction_thirdApps_icon_img__${view.state.activeThirdApp}`] = {
                'border': '2px solid #ffc474',
                'opacity': '1'
            };
            css[`setTrendAction_thirdApps_icon_label__${view.state.activeThirdApp}`] = {
                'display': 'block'
            };
        }

        return css;
    }, // end generate

};

export default styles;
