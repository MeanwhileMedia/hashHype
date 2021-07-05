import path from 'path';
import fs from 'fs';
import * as babel from "@babel/core";
import hbCodeChecker from './hbCodeChecker.js';

var hbServeJs = {

    jsDirs: [], // the path(s) which hold our js files

    init(dir, opts) {
        if (hbServeJs.jsDirs.indexOf(dir) === -1) hbServeJs.jsDirs.push(dir);

        // Return the generator as koa middleware
        return function (ctx, next) {
            if (hbServeJs.isJs(ctx)) {
                const compiledCode = hbServeJs.compileResponse(ctx, opts);
                if (typeof compiledCode === 'undefined') {
                    console.log(`File not found at incoming js request url. ${ctx.request.url}`);
                    return next();
                }
                const maxAge = opts.maxAge || 0;
                ctx.set({
                    'Content-Type': 'application/javascript;charset=utf-8',
                    'Content-Length': Buffer.byteLength(compiledCode),
                    'Cache-Control': `max-age=${maxAge / 1000}`, // maxage is passed to this middleware in ms. Header is in s
                });
                ctx.body = compiledCode;
            } else {
                return next();
            }
        };
    },

    isJs(ctx) {
        // Is the request for a file with js extension?
        return ctx.request.url.match(/\.(js)/); // This rule must also match JSX files
    },

    isJsx(ctx) {
        // Is the request for a file with jsx extension?
        return ctx.request.url.match(/\.(jsx)/);
    },

    compileResponse(ctx, opts) {
        let relFilePath = ctx.request.url;
        const requestUrlHasQueryParams = relFilePath.search(/(\.js)(x)?(\?){1}/); // https://regexr.com/5sard
        if (requestUrlHasQueryParams !== -1) {
            relFilePath = relFilePath.replace(/(\.js)(x)?(\?){1}(\S*)/, '$1$2'); // https://regexr.com/5sard
        }

        let filePath;
        hbServeJs.jsDirs.some((thisJsDir) => {
            const tryPath = path.join(thisJsDir, relFilePath);
            if (fs.existsSync(tryPath)) {
                filePath = tryPath;
                return true; // break some loop
            }
        });
        if (!filePath) { return undefined; }

        let compiled;
        const codeFile = hbCodeChecker.cleanCodeFileForFE(filePath, ctx);
        compiled = {
            code: codeFile.contents
        };
        if (hbServeJs.isJsx(ctx)) {
            compiled = babel.transformSync(compiled.code, {
                presets: ['@babel/react'],
            });
        }
        console.log(`Requested JS(X) file was compiled: ${filePath}`);

        return compiled.code;
    },

}; // end hbServeJs

export default hbServeJs.init;
