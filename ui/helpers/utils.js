import throttleDebounce from '/node_modules/throttle-debounce';

// random helper functions that don't belong to any specific component
const utils = {

    init() {
        // console.log('Utils init...');
        utils.setPageRemParent();
        utils.initWindowResizeListener();
        utils.initKeyboardCtrlsListener();

        utils.registerWindowResizeEvent('setPageRemParent', utils.setPageRemParent);
    },

    windowResizeEvents: {}, // {'eventName': func, etc..}
    registerWindowResizeEvent(eventName, func) { // must pass unique eventName arg to registerWindowResizeEvent to avoid duplicated events
        utils.windowResizeEvents[eventName] = func;
    },
    initWindowResizeListener() {
        window.addEventListener('resize', throttleDebounce.debounce(200, () => {
            for (const [eventName, eventFunc] of Object.entries(utils.windowResizeEvents)) {
                // console.log(`${eventName} for window resize...`);
                eventFunc();
            };
        }));
    },

    keyboardCtrlsEvents: {}, // {'eventName': {keyOpts: {keyCode: 'keyCode', etc..}, func: func}, etc..}
    registerKeyboardCtrlsListener(eventName, func, keyOpts) { // must pass unique eventName arg to registerKeyboardCtrlsListener to avoid duplicated events
        // keyOpts should be identical to a native key key event fragment. Used below are keyOpts.keyCode, keyOpts.ctrlKey, and keyOpts.shiftKey
        utils.keyboardCtrlsEvents[eventName] = {keyOpts, func};
    },
    initKeyboardCtrlsListener() {
        document.addEventListener('keydown', (event) => {
            for (const [eventName, eventOpts] of Object.entries(utils.keyboardCtrlsEvents)) {
                if (event.keyCode === eventOpts.keyOpts.keyCode && event.ctrlKey === eventOpts.keyOpts.ctrlKey && event.shiftKey === eventOpts.keyOpts.shiftKey) {
                    // console.log(`${eventName} for "${event.key}" keydown...`);
                    eventOpts.func();
                }
            };
        });
    },

    // getMagicScreenMeasure function returns a px measurement which accounts for screeen size, orientation, and pixel density.
    // Is used to set the font-size on our <html> element for rem child inheritance.  By setting our global font size as a
    // static px, we can code responsive "min(Xrem, Yvw)" measurments on child elements in a more predictable manner.
    baseFontSize: 10, // 10px is our starting point.
    scaleDownAtWidth: 1024, // scale down for window widths less than 1024px (but no more than 80% dowwnscale)
    curMagicScreenMeasure: 10, // updated every time getMagicScreenMeasure runs
    curMagicScreenScale: 1, // baseFontSize/curMagicScreenMeasure - updated every time getMagicScreenMeasure runs
    getMagicScreenMeasure() { // returns integer (NO unit applied to return value)
        // 1. When accounting for devicePixelRatio, magicScreenMeasure should increase proportionately to devicePixelRatio. This allows scaled up text for high retina displays
        let devicePixelResMultiplier = Math.max(1, window.devicePixelRatio);
        let magicScreenMeasure = utils.baseFontSize * devicePixelResMultiplier;
        // 2. Scale down for window widths less than 1024px (but no more than 80% dowwnscale)
        magicScreenMeasure = magicScreenMeasure * Math.min(1, Math.max(window.innerWidth/utils.scaleDownAtWidth, .8));

        utils.curMagicScreenMeasure = magicScreenMeasure;
        utils.curMagicScreenScale = utils.curMagicScreenMeasure / utils.baseFontSize;
        return magicScreenMeasure; // integer
    },

    setPageRemParent() {
        const htmlEl = document.querySelector('html');
        const magicScreenMeasure = utils.getMagicScreenMeasure();
        htmlEl.style.fontSize = magicScreenMeasure + 'px';
        utils.setMagicScaleElements(magicScreenMeasure);
    },

    setMagicScaleElements(magicScreenMeasure = null) {
        if (!magicScreenMeasure) magicScreenMeasure = utils.getMagicScreenMeasure();
        // an additional feature of getMagicScreenMeasure is to search for els with class "magicScale"
        // and apply a transform: scale to each of them using utils.curMagicScreenScale. This is useful
        // for widgets with complex CSS that do better with px measurements, than an overall scale (like our hbWidgets).
        const magicScaleEls = document.querySelectorAll('.magicScale');
        magicScaleEls.forEach((thisMagicScaleEl) => {
            thisMagicScaleEl.firstChild.style.transform = `scale(${utils.curMagicScreenScale})`;
            thisMagicScaleEl.firstChild.style.transformOrigin = `top`;
        });
    }

}; // end utils

utils.init();

export default utils;
