import throttleDebounce from '/node_modules/throttle-debounce';

// random helper functions that don't belong to any specific component
var utils = {

    init() {
        utils.setPageRemParent();
        window.addEventListener('resize', throttleDebounce.debounce(200, utils.setPageRemParent));
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
        // for widgets with complex CSS that do better with px measurements, then an overall scale (like our hbWidgets).
        const magicScaleEls = document.querySelectorAll('.magicScale');
        magicScaleEls.forEach((thisMagicScaleEl) => {
            thisMagicScaleEl.style.transform = `scale(${utils.curMagicScreenScale})`;
        });
    }

}; // end utils

utils.init();

export default utils;
