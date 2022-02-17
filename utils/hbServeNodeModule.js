import path from 'path';
import fs from 'fs';
import webpack from 'webpack';

var hbServeNodeModule = {

    init(opts) {
        const self = hbServeNodeModule;
        self.nodeModulesPath = opts.nodeModulesPath; // the path to our apps node_modules directory.
        self.compiledFilesDirPath = opts.compiledFilesDirPath; // the temp directory that webpack outputs to. This directory is cleared during a deploy routine (non dev).

        // Return the generator as koa middleware
        return async function (ctx, next) {
            // Check if the incoming request is for a node_modules library. If so, correct it's alias path to the actual js file path,
            // and we also need to run it through webpack so it can be served as an ES module to the browser.
            if (!opts.bareModuleMap[ctx.request.url]) return next();
            const bareModulePath = opts.bareModuleMap[ctx.request.url].replace('/node_modules', self.nodeModulesPath);
            const moduleFileText = await self.packNodeModuleToEsModule(bareModulePath, ctx.request.url);
            ctx.body = moduleFileText;

            ctx.set({
                'Content-Type': 'application/javascript;charset=utf-8',
                'Content-Length': Buffer.byteLength(moduleFileText),
            });
        };
    },

    packNodeModuleToEsModule(bareModulePath, requestedPath){ //requestedPath is the exact string declared in the import statement: import react from "/node_modules/react"
        const self = hbServeNodeModule;
        const snakeToCamel = (str) => str.replace(/([-_][a-z])/g, (group) => {
            return group.toUpperCase().replace('-', '').replace('_', '')
        });
        const requestedLibName = snakeToCamel(requestedPath.replace('/node_modules/', '').replace('/', '__')); // make a safe name for saving the compiles JS src as a new file to disk.

        return new Promise( (resolve, reject) => {

            // First check if this is a request for a css of svg asset that lives within node_modules. They are not webpacked or cached to local disk.
            if(requestedPath.search(/\.css$/) !== -1) {
                self.packNodeModuleCssToEsModule(bareModulePath, (esModuleText) => {
                    resolve(esModuleText);
                });
                // We do not cache packed css modules to disk
                return;
            }
            if(requestedPath.search(/\.svg$/) !== -1) {
                self.packNodeModuleSvgToEsModule(bareModulePath, (esModuleText) => {
                    resolve(esModuleText);
                });
                // We do not cache packed svg modules to disk
                return;
            }

            // Next check our local disk for this JS module. May have already been compiled and cached to disk. These files get cleared out during any (non dev) deploy routine.
            const compiledDirPath = path.resolve(self.compiledFilesDirPath);
            const compiledFilename = `${requestedLibName}.js`;
            const compiledFilePath = path.resolve(compiledDirPath, compiledFilename);
            self.readCompiledLocalFile(compiledFilePath, (cachedFileCodeStr) => {
                if(cachedFileCodeStr) {
                    console.log(`Found a cached version of requested node_module: ${bareModulePath}`);
                    resolve(cachedFileCodeStr);
                    return;
                }

                console.log(`Now attempting to serve request for a node_module: ${bareModulePath}`);
                const wpCompiler = webpack({
                    mode: 'production',
                    entry: bareModulePath,
                    target: 'web',
                    externals: {
                        react: 'react',
                    },
                    output: {
                        path: compiledDirPath,
                        filename: compiledFilename,
                        libraryTarget: 'window',
                        library: requestedLibName,
                    },
                }, (err, stats) => {
                    if (err || stats.hasErrors() ) {
                        console.error(`Error while webpacking requested node_modules library: ${err} ${stats}`); //${stats.toJson("minimal")}`);
                    }

                    self.readCompiledLocalFile(compiledFilePath, (compiledFileCodeStr) => {
                        // At this point, compiledFileCodeStr will be the exact output from webpack. We have not yet manually wrapped it in ES module export statement.
                        // Alter the compiledFileCodeStr now, then save changes back to disk file. That file is served directly as a cached asset for future requests.
                        const esModuleText = `${compiledFileCodeStr} \n \n export default ${requestedLibName};`;
                        console.log(`Compiled node_modules asset into ES module format: ${bareModulePath}`); // -> ${esModuleText}`);
                        resolve(esModuleText);

                        fs.writeFile(compiledFilePath, esModuleText, (err) => {
                            console.log(`Cached compiled node module to local disk: ${compiledFilePath}`);
                            if (err) console.log(err);
                        });
                    });

                }); // end webpack
            }); // end self.readCompiledLocalFile
        }); // end return new Promise

    }, // end packNodeModuleToEsModule

    readCompiledLocalFile(compiledFilePath, cback) {
        // will return code string if found, null otherwise (which will then trigger a webpack to compile from node_modules)
        fs.readFile(compiledFilePath, (err, compiledText) => {
           if(err || !compiledText) {
               console.log(err);
               if (cback) cback(null);
               return;
           }
           if (cback) cback(compiledText);
       });
    },

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
