import path from 'path';
import fs from 'fs';
import hbCodeChecker from './hbCodeChecker.js';

var hbServeHtml = {

    htmlDirs: [], // the path(s) which hold our html files

    init(dir, opts) {
        if (hbServeHtml.htmlDirs.indexOf(dir) === -1) hbServeHtml.htmlDirs.push(dir);

        // Return the generator as koa middleware
        return function (ctx, next) {
            if (hbServeHtml.isHtml(ctx)) {
                const compiledCode = hbServeHtml.compileResponse(ctx, opts);
                if (typeof compiledCode === 'undefined') {
                    console.log(`File not found at incoming html request url. ${ctx.request.url}`);
                    return next();
                }
                ctx.set({
                    'Content-Type': 'text/html;charset=utf-8',
                    'Content-Length': Buffer.byteLength(compiledCode),
                });
                ctx.body = compiledCode;
            } else {
                return next();
            }
        };
    },

    isHtml(ctx) {
        // Is the request for a file with html extension?
        return ctx.request.url.match(/\.(html)/);
    },

    compileResponse(ctx, opts) {
        let relFilePath = ctx.request.url;
        const requestUrlHasQueryParams = relFilePath.lastIndexOf('.html?')
        if (requestUrlHasQueryParams !== -1) relFilePath = relFilePath.slice(0, requestUrlHasQueryParams)+'.html';

        let filePath;
        hbServeHtml.htmlDirs.some((thisHtmlDir) => {
            const tryPath = path.join(thisHtmlDir, relFilePath);
            if (fs.existsSync(tryPath)) {
                filePath = tryPath;
                return true; // break some loop
            }
        });
        if (!filePath) { return undefined; }

        const codeFile = hbCodeChecker.cleanCodeFileForFE(filePath, ctx);
        const compiled = {
            code: codeFile.contents
        };
        console.log(`Requested HTML file was compiled: ${filePath}`);

        return compiled.code;
    },

}; // end hbServeHtml

export default hbServeHtml.init;
