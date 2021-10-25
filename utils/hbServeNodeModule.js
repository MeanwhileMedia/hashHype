import path from 'path';
import fs from 'fs';
import webpack from 'webpack';

var hbServeNodeModule = {

    init(opts) {
        const self = hbServeNodeModule;
        self.redisClient = opts.redisClient;
        self.nodeModulesPath = opts.nodeModulesPath;

        // Return the generator as koa middleware
        return async function (ctx, next) {
            // Check if the incoming request is for a node_modules library. If so, correct it's alias path to the actual js file path,
            // and we also need to run it through webpack so it can be served as an ES module to the browser.
            if (!opts.bareModuleMap[ctx.request.url]) return next();
            const bareModulePath = opts.bareModuleMap[ctx.request.url].replace('/node_modules', self.nodeModulesPath);
            const moduleFileText = await self.packNodeModuleToEsModule(bareModulePath, ctx.request.url);
            ctx.body = moduleFileText;

            const maxAge = opts.resOpts.maxAge || 0;
            ctx.set({
                'Content-Type': 'application/javascript;charset=utf-8',
                'Content-Length': Buffer.byteLength(moduleFileText),
                'Cache-Control': `max-age=${maxAge / 1000}`, // maxage is passed to this middleware in ms. Header is in s
            });
        };
    },

    packNodeModuleToEsModule(bareModulePath, requestedPath){ //requestedPath is the exact string declared in the import statement: import react from "node_modules/react"
        const self = hbServeNodeModule;
        const snakeToCamel = (str) => str.replace(/([-_][a-z])/g, (group) => {
            return group.toUpperCase().replace('-', '').replace('_', '')
        });
        const requestedLibName = snakeToCamel(requestedPath.split('/').pop());

        return new Promise( (resolve, reject) => {
            // First check our FE js modules that have been cached to redis DB. This really only applies to dev environment because on prod everything is CDN cached.
            const clientAssetCacheKey = `clientAssetCache:${bareModulePath}`;
            self.redisClient.get(clientAssetCacheKey, (cachedAssetObj) => {
                if(cachedAssetObj) {
                    console.log(`Found a cached version of requested node_module: ${bareModulePath}`);
                    resolve(cachedAssetObj.code);
                    return;
                }

                const cachedAssetPending = {path: bareModulePath, code: ''};
                const compiledPath = path.resolve(self.nodeModulesPath);
                const compiledFilename = `bareModule_${Date.now()}.js`;
                console.log(`Now attempting to serve request for a node_module: ${bareModulePath}`);

                if(requestedPath.search(/\.css$/) !== -1) {
                    self.packNodeModuleCssToEsModule(bareModulePath, (esModuleText) => {
                        cachedAssetPending.code = esModuleText;
                        resolve(cachedAssetPending.code);
                        self.redisClient.set(clientAssetCacheKey, cachedAssetPending);
                    });
                    return;
                }

                if(requestedPath.search(/\.svg$/) !== -1) {
                    self.packNodeModuleSvgToEsModule(bareModulePath, (esModuleText) => {
                        cachedAssetPending.code = esModuleText;
                        resolve(cachedAssetPending.code);
                        self.redisClient.set(clientAssetCacheKey, cachedAssetPending);
                    });
                    return;
                }

                const wpCompiler = webpack({
                    mode: 'production',
                    entry: bareModulePath,
                    target: 'web',
                    externals: {
                        react: 'react',
                    },
                    output: {
                        path: compiledPath,
                        filename: compiledFilename,
                        libraryTarget: 'window',
                        library: requestedLibName,
                    },
                }, (err, stats) => {
                    if (err || stats.hasErrors() ) {
                        console.log(`Error while webpacking requested node_modules library: ${err} ${stats}`); //${stats.toJson("minimal")}`);
                    }
                    //read local file to send back as text, then delete the local output file(s)
                    const compiledFilePath = path.resolve(compiledPath, compiledFilename);
                    fs.readFile(compiledFilePath, (err, compiledText) => {
                        if(err) console.log(err);
                        const esModuleText = `${compiledText} \n \n export default ${requestedLibName};`;
                        console.log(`Compiled node_modules asset into ES module format: ${bareModulePath}`); // -> ${esModuleText}`);
                        cachedAssetPending.code = esModuleText;
                        resolve(cachedAssetPending.code);
                        self.redisClient.set(clientAssetCacheKey, cachedAssetPending);

                        fs.unlink(compiledFilePath, (err) => {
                            if(err) console.log(err);
                            fs.unlink(compiledFilePath.replace('.js', '.js.LICENSE.txt'), () => {});
                        });
                    });
                }); // end webpack
            }); // end self.redisClient.get(clientAssetCacheKey
        }); // end return new Promise

    }, // end packNodeModuleToEsModule

    packNodeModuleCssToEsModule(bareModulePath, cback) {
        // Looks like this was an ES module request for a CSS file inside a node module - wrap the css content in JS that will auto inject it to the page
        fs.readFile(bareModulePath, (err, cssText) => {
            const esModuleText = `const injectCss = () => {
                let styleEl = document.createElement('style');
                styleEl.innerHTML = "${cssText}";
                document.body.appendChild(styleEl);
            };
            injectCss();
            export default injectCss;`.replace(/(\r\n|\n|\r)/gm, ""); //remove linebreaks
            console.log(`Compiled CSS into ES module format: ${bareModulePath}`);
            if (cback) cback(esModuleText);
        });
    }, // end packNodeModuleCssToEsModule

    packNodeModuleSvgToEsModule(bareModulePath, cback) {
        // Looks like this was an ES module request for an svg file inside a node module - wrap the svg markup in a an export
        fs.readFile(bareModulePath, (err, svgText) => {
            if (err) console.error(err);
            const esModuleText = `const svg = \`${svgText}\`; export default svg;`;
            console.log(`Compiled SVG into ES module format: ${bareModulePath}`);
            if (cback) cback(esModuleText);
        });
    }, // end packNodeModuleSvgToEsModule

}; // end hbServeNodeModule

export default hbServeNodeModule.init;
