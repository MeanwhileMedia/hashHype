import React from '/node_modules/react';
import Radium from '/node_modules/radium';

import data_saver_on from '/node_modules/@material-icons/data_saver_on.svg';
import account_circle from '/node_modules/@material-icons/account_circle.svg';
import settings from '/node_modules/@material-icons/settings.svg';
import cancel_presentation from '/node_modules/@material-icons/cancel_presentation.svg';
import error from '/node_modules/@material-icons/error.svg'
import check_circle_outline from '/node_modules/@material-icons/check_circle_outline.svg';
import dangerous from '/node_modules/@material-icons/dangerous.svg';
import article from '/node_modules/@material-icons/article.svg';

class Icon extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            iconName: this.props.iconName || '',
            width: this.props.width || '',
            height: this.props.height || '', // if only one of width or height are non-falsy, this component will automatically preserve aspect ratio.
        };

        this.availableIcons = {
            data_saver_on,
            account_circle,
            settings,
            cancel_presentation,
            error,
            check_circle_outline,
            dangerous,
            article
        };
    }

    getRequestedIconName() {
        if (!this.state.iconName) {
            console.warn('The icon widget must have a props.iconName defined.');
            return null;
        }
        if (!this.availableIcons[this.state.iconName]) {
            console.warn(`Specified iconName does not exist: ${this.state.iconName}`);
            return null;
        }
        return this.availableIcons[this.state.iconName];
    }

    calcIconPxSize(tempIconEl, preserveAspectRatio = true) {
        // This component accepts rem units as width and height settings but will convert them to px for better browser support.
        let width = this.state.width;
        let height = this.state.height;
        const aspectRatio = this.getIconAspectRatio(tempIconEl);

        if (width && width.indexOf('%') === -1) {
            if (width.indexOf('rem') !== -1) width = this.convertRemToPx(width);
            if (!height && preserveAspectRatio && aspectRatio) height = `${parseFloat(width) / aspectRatio}`;
        }
        if (height && height.indexOf('%') === -1) {
            if (height.indexOf('rem') !== -1) height = this.convertRemToPx(height);
            if (!width && preserveAspectRatio && aspectRatio) width = `${parseFloat(height) * aspectRatio}`;
        }

        const size = {
            width: width || null,
            height: height || '70%' // when neither height nor width are passed as props, this component defaults to setting height 70%, width unset
        };
        // console.log('calcIconPxSize:', size);
        return size;
    }
    convertRemToPx (rem) {
        const htmlEl = document.querySelector('html');
        const globalPx = parseFloat(htmlEl.style.fontSize);
        return globalPx * parseFloat(rem);
    }

    getIconAspectRatio(tempIconEl) {
        let aspectRatio = null;
        let width = null;
        let height = null;
        const tempSvgEl = tempIconEl.querySelector('svg');
        width = tempSvgEl.getAttribute('width') || null;
        height = tempSvgEl.getAttribute('height') || null;
        if (width && height) aspectRatio = parseFloat(width) / parseFloat(height);
        // console.log('getIconAspectRatio:', aspectRatio);
        return aspectRatio;
    }

    setIconSize(tempIconEl, iconSize) {
        const tempSvgEl = tempIconEl.querySelector('svg');
        if (iconSize.width) {
            tempSvgEl.setAttribute('width', iconSize.width);
        } else {
            tempSvgEl.removeAttribute('width');
        }
        if (iconSize.height) {
            tempSvgEl.setAttribute('height', iconSize.height);
        } else {
            tempSvgEl.removeAttribute('height');
        }
    }

    render() {
        const iconSvg = this.getRequestedIconName();
        const tempIconEl = document.createElement("div");
        tempIconEl.innerHTML = iconSvg;

        const targetIconSize = this.calcIconPxSize(tempIconEl, true);
        this.setIconSize(tempIconEl, targetIconSize);

        return (
            <span class="hbWidgets icon" dangerouslySetInnerHTML={{__html: tempIconEl.innerHTML}}></span>
        );
    }
}

export default Radium(Icon);
