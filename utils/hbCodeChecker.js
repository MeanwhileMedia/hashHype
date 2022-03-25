import path from 'path';
import fs from 'fs';
import hbCodeCheckerConfig from './hbCodeChecker-config.js';

// This util contains features to pre-process view files while being compiled in uiServer. It does things like strip admin code
// when the user does not have permissions. See hbCodeCheckerConfig for more info on the in-use code delimeters and associated logic.
const hbCodeChecker = {

    cleanCodeFileForFE(filePath, uiServerCtx) {
        let codeFile = {contents: ''};
        if (!fs.existsSync(filePath)) { return codeFile; }
        codeFile.contents = fs.readFileSync(filePath, 'utf8');

        codeFile = hbCodeChecker.stripAdminCode(codeFile, uiServerCtx);
        codeFile = hbCodeChecker.applyReqModifier(codeFile, uiServerCtx);

        return codeFile;
    },

    stripAdminCode(codeFile, uiServerCtx) {
        let cleanedCode = codeFile.contents;
        const delimeterOpen = hbCodeCheckerConfig.delimeters.fEAdmin[0];
        const delimeterClose = hbCodeCheckerConfig.delimeters.fEAdmin[1];
        const adminCodeStatus = hbCodeChecker.shouldServeFEAdminAsset(uiServerCtx);
        if (adminCodeStatus.shouldServe) {
            const delimeterRegex = new RegExp(`(${delimeterOpen})|(${delimeterClose})`, 'gm'); // https://regexr.com/5s4od
            cleanedCode = cleanedCode.replace(delimeterRegex, '');
            if (cleanedCode !== codeFile.contents) console.warn(`A request for a FE admin asset (${uiServerCtx.request.url}) will be served for user: ${adminCodeStatus.adminInfo.name}`);
            codeFile.contents = cleanedCode;
        } else {
            cleanedCode = codeFile.contents;
            const delimeterRegex = new RegExp(`(${delimeterOpen})((?!${delimeterClose})(\\s|\\S))*(${delimeterClose})`, 'gm'); // https://regexr.com/5s4lg
            const adminCodeMatches = codeFile.contents.match(delimeterRegex);
            if (adminCodeMatches) {
                adminCodeMatches.forEach((thisMatchedCodeChunk) => {
                    cleanedCode = cleanedCode.replace(thisMatchedCodeChunk, '');
                });
            }
            codeFile.contents = cleanedCode;
        }
        return codeFile;
    },

    shouldServeFEAdminAsset(uiServerCtx, adminUid = null) {
        let adminCodeStatus = {shouldServe: false, adminInfo: ''};
        if (!adminUid) { // can be passed directly to this function, OR if isn't then this function will check req and res cookies
            if (uiServerCtx.cookies && uiServerCtx.cookies.get('fEAdmin')) {
                adminUid = uiServerCtx.cookies.get('fEAdmin');
            } else {
                // In some cases (if the user just landed and is starting a new session) our cookies will only be on the response object (which was not yet sent). Check there too.
                adminUid = hbCodeChecker.getResponseCookie('fEAdmin', uiServerCtx);
                if (!adminUid) return adminCodeStatus;
            }
        }
        if (hbCodeCheckerConfig.secrets.fEAdmin.indexOf(adminUid) !== -1 && hbCodeCheckerConfig.secretUserInfo[adminUid]) {
            const adminUserInfo = hbCodeCheckerConfig.secretUserInfo[adminUid];
            if (uiServerCtx.request.ip && adminUserInfo.ip && uiServerCtx.request.ip.match(adminUserInfo.ip)) {
                adminCodeStatus.shouldServe = true;
                adminCodeStatus.adminInfo = hbCodeCheckerConfig.secretUserInfo[adminUid];
                adminCodeStatus.matchedIp = uiServerCtx.request.ip;
            }
        }
        return adminCodeStatus;
    },

    applyReqModifier(codeFile, uiServerCtx) {
        const reqModifier = hbCodeChecker.getReqModifier(uiServerCtx);
        if (!reqModifier.stringified) return codeFile;

        ////////
        // 1. First apply reqModifier to sync js module imports: import foo from 'foo';
        let cleanedCode = codeFile.contents;
        const jsImportRegex = new RegExp(`import( )+(\\S)+( )+from( )+('|"|\`)(\\S)+\\.js(x)?`, 'gm'); // https://regexr.com/5sa1h
        const jsImportCodeMatches = codeFile.contents.match(jsImportRegex);
        if (jsImportCodeMatches) {
            let cleanedCode = codeFile.contents;
            jsImportCodeMatches.forEach((thisMatchedCodeChunk) => {
                cleanedCode = cleanedCode.replace(thisMatchedCodeChunk, thisMatchedCodeChunk+`?reqModifier=${reqModifier.stringified}`);
            });
            console.log(`The reqModifier param (reqModifier=${reqModifier.stringified}) was applied to ${jsImportCodeMatches.length} import .js statements in file: ${uiServerCtx.request.url}`);
            codeFile.contents = cleanedCode;
        }

        ////////
        // 2. Apply reqModifier to async js module imports: import(message.data.viewPath ).then((asyncModule) => {
        const jsAsyncImportRegex = new RegExp(`import\\(((?!\\))(\\s|\\S))+\\)\\.then\\(`, 'gm'); // https://regexr.com/5sagk
        const jsAsyncImportCodeMatches = codeFile.contents.match(jsAsyncImportRegex);
        if (jsAsyncImportCodeMatches) {
            cleanedCode = codeFile.contents;
            jsAsyncImportCodeMatches.forEach((thisMatchedCodeChunk) => {
                const codeChunkClose = ').then(';
                const unclosedCodeChunk = thisMatchedCodeChunk.replace(codeChunkClose, '');
                cleanedCode = cleanedCode.replace(thisMatchedCodeChunk, unclosedCodeChunk+`+'?reqModifier=${reqModifier.stringified}'${codeChunkClose}`);
            });
            console.log(`The reqModifier param (reqModifier=${reqModifier.stringified}) was applied to ${jsImportCodeMatches.length} async import statements in file: ${uiServerCtx.request.url}`);
            codeFile.contents = cleanedCode;
        }

        ////////
        // 3. Apply reqModifier to script tags in html: <script type="module" src="/ui/helpers/hbClient.js"></script> (MUST have src attr with local absolute url)
        const scriptTagRegex = new RegExp(`<script((?!<\\/script>)(\\s|\\S))+(src="\\/)((?!<\\/script>)(\\s|\\S))+<\\/script>`, 'gm'); // https://regexr.com/68l5a
        const scriptTagCodeMatches = codeFile.contents.match(scriptTagRegex);
        if (scriptTagCodeMatches) {
            cleanedCode = codeFile.contents;
            scriptTagCodeMatches.forEach((thisMatchedCodeChunk) => {
                const codeChunkWithReqModifier = thisMatchedCodeChunk.replace(/(\.js)('|"|`)/, `$1?reqModifier=${reqModifier.stringified}$2`); // https://regexr.com/5san6
                cleanedCode = cleanedCode.replace(thisMatchedCodeChunk, codeChunkWithReqModifier);
            });
            console.log(`The reqModifier param (reqModifier=${reqModifier.stringified}) was applied to ${scriptTagCodeMatches.length} script tags in file: ${uiServerCtx.request.url}`);
            codeFile.contents = cleanedCode;
        }

        return codeFile;
    },

    getReqModifier(uiServerCtx) {
        let reqModifier = {modifiers: [], stringified: ''};
        let reqModifierCookieJson;

        if (uiServerCtx.cookies && uiServerCtx.cookies.get('reqModifier')) {
            reqModifierCookieJson = uiServerCtx.cookies.get('reqModifier');
        } else {
            // In some cases (if the user just landed and is starting a new session) our cookies will only be on the response object (which was not yet sent). Check there too.
            reqModifierCookieJson = hbCodeChecker.getResponseCookie('reqModifier', uiServerCtx);
            if (!reqModifierCookieJson) return reqModifier;
        }

        let reqModifierArray;
        try {
            reqModifierArray = JSON.parse(reqModifierCookieJson);
        } catch (error) {
            console.warn(`Invalid reqModifierArray JSON read from cookie: ${reqModifierCookieJson}`);
            return reqModifier;
        }
        const reqModifiersArraySorted = reqModifierArray.filter(Boolean).sort(); // remove falsies and sort alphabetically before converting to string. This makes for a consistent pattern to optimize our caching.
        reqModifier.modifiers = reqModifiersArraySorted;
        reqModifier.stringified = reqModifiersArraySorted.join('_'); // our reqModifier string (appended to all js requests from client) uses a _ delimeter.
        return reqModifier;
    },

    getResponseCookie(cookieId, uiServerCtx) {
        let cookieVal = null;
        if (uiServerCtx.response.get('Set-Cookie') && uiServerCtx.response.get('Set-Cookie').length > 0) {
            const setCookies = uiServerCtx.response.get('Set-Cookie');
            let targetCookieString;
            setCookies.some((thisSetCookie) => {
                if (thisSetCookie.indexOf(`${cookieId}=`) === 0) {
                    targetCookieString = thisSetCookie;
                    return true; // break some loop
                }
            });
            if (targetCookieString) {
                cookieVal = targetCookieString.split(';')[0].split('=')[1]
            }
        }
        return cookieVal;
    }

}; // end hbCodeChecker

export default hbCodeChecker;
