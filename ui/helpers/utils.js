import throttleDebounce from '/node_modules/throttle-debounce';

// random helper functions that don't belong to any specific component
var utils = {

    init() {
        utils.setPageRemParent();
        window.addEventListener('resize', throttleDebounce.debounce(200, utils.setPageRemParent));
    },

    // getMagicScreenMeasure function returns a px measurement which accounts for screeen size, orientation, and pixel density.
    // Is used to set the font-size on our <html> element for rem child inheritance.
    // Design is for desktop first, with our reference device being a 4k monitor, devicePixelRatio of 2, text scaling to mimic a resolution of 2560 x 1440.
    baseFontSize: 10, // 10px is our starting point.
    refVMax: 2560, // 2560 x 1440 resolution - our ref device
    refScreenRatio: .56, // 2560 x 1440 ratio - our ref device
    devicePixelResMultiplier: Math.max(window.devicePixelRatio, 2), // scales up text for high retina displays, but will never go below 2 (the pixel density of our ref device)
    curMagicScreenMeasure: 10, // updated every time getMagicScreenMeasure runs
    curMagicScreenScale: 1, // baseFontSize/curMagicScreenMeasure - updated every time getMagicScreenMeasure runs
    getMagicScreenMeasure() { // returns integer (NO unit applied to return value)
        // 1. When accounting for devicePixelRatio, magicScreenMeasure should increase proportionately to devicePixelRatio.
        let magicScreenMeasure = utils.baseFontSize * utils.devicePixelResMultiplier; // Our reference device is now at
        // 2. When screen size (vmax) dips below our refVMax, magicScreenMeasure should decrease proportionately.
        const vMax = Math.max(window.innerWidth, window.innerHeight);
        magicScreenMeasure = magicScreenMeasure * Math.min((vMax / utils.refVMax), 1);
        // 3. When becomes portrait, magicScreenMeasure should decrease
        const screenRatio = window.innerWidth / window.innerHeight;
        magicScreenMeasure = magicScreenMeasure * Math.max(Math.min(screenRatio, 1), 0.8);
        // 4. WWhen accounting for viewport aspect ratio, magicScreenMeasure should decrease for narrow ratios (portrait AND landscape - so our ratio is always vmin / vmax)
        const absScreenRatio =  Math.min(window.innerWidth, window.innerHeight) / Math.max(window.innerWidth, window.innerHeight);
        magicScreenMeasure = magicScreenMeasure - (magicScreenMeasure * Math.max(utils.refScreenRatio - absScreenRatio, 0));

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
        // for widgets with complex CSS that do better with px measurements, then an overall scale (like our hbWidgets).
        const magicScaleEls = document.querySelectorAll('.magicScale');
        magicScaleEls.forEach((thisMagicScaleEl) => {
            thisMagicScaleEl.style.transform = `scale(${utils.curMagicScreenScale})`;
        });
    }

}; // end utils

utils.init();

export default utils;
