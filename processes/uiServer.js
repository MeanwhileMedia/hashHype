import fs from 'fs';
import util from 'util';
import path from 'path';
import http from 'http';
import _ from 'underscore';
import webpack from 'webpack';
import Koa from 'koa';
import koaConvert from 'koa-convert';
import koaStatic from 'koa-static';
import koaSend from 'koa-send';
import koaWebsocket from 'koa-websocket';
import koaJsx from '../utils/koaJsx.js';
import HbClientSocketDbResponses_admin from '../utils/hbClientSocketDbResponses-admin.js';
import RedisClient from '../utils/redisClient.js';

// Koa handles all request routing and middleware for serving static files. koa.io holds our
// socket.io server which links our views to models. Both are defined and initialized here.
const uiServer = {

    serverConfig: {
        rootDir: process.cwd(), //the project root
        httpPort: 8180
    },

    // ES module imports in browser do not yet support "bare" module imports. Maintain a map here, and use a custom syntax to import node_modules.
    // Not yet supported: 'import _ from "underscore"'
    // Current polyfill: 'import _ from "/node_modules/underscore"'
    // See https://medium.com/webpack/the-state-of-javascript-modules-4636d1774358
    bareModuleMap: {
        '/node_modules/underscore': '/node_modules/underscore/underscore-min.js',
        '/node_modules/react': '/node_modules/react/cjs/react.production.min.js',
        '/node_modules/react-dom': '/node_modules/react-dom/cjs/react-dom.production.min.js',
        '/node_modules/d3': '/node_modules/d3/dist/d3.min.js',
        '/node_modules/hammerjs': '/node_modules/hammerjs/hammer.min.js',
        '/node_modules/radium': '/node_modules/radium/dist/radium.min.js',
        '/node_modules/highlight': '/node_modules/highlight.js/lib/core.js',
        '/node_modules/highlight/js': '/node_modules/highlight.js/lib/languages/javascript.js',
        '/node_modules/highlight/jsStyles.css': '/node_modules/highlight.js/styles/atom-one-dark.css'
    },

    // In defining our koa middleware (below), we expose specific directories to public requests.
    // As a result, the url 'site.com/publicUtil.js' actually resolves to /utils/public/publicUtil.js. (/utils/public/ is one of the exposed directories at a 'root' url path)
    // This causes our require paths to be out of sync between server and client modules. To compensate,
    // we are setting "routeProxies" to support consistent paths, and koa's flat asset pipeline below.
    routeProxies: [
        { target: '/ui/views/', redirect: '/', applyExtension: '.jsx' }, //applyExtension will always be appended to request.url - it allows ES import paths without extensions (for consistency with backend)
        { target: '/ui/views/styles/', redirect: '/', applyExtension: '.js'},
        { target: '/ui/views/styles/css/', redirect: '/css/', applyExtension: '.css'},
        { target: '/ui/helpers/', redirect: '/', applyExtension: '.js' },
    ],

    init() {
        uiServer.initRedisClient( () => {
            uiServer.initKoaServer();
            uiServer.hbClientSocketDbResponses_admin = new HbClientSocketDbResponses_admin({
                redisClient: uiServer.redisClient
            });
        });
    }, // init

    initKoaServer() {
        const self = uiServer;
        self.server = koaWebsocket(new Koa());

        self.server.use((ctx, next) => {
            const start = new Date(); // response time logger
            return next().then(() => {
                const ms = new Date() - start;
                console.log(`${ctx.request.method} ${ctx.request.url} - ${ms} ms`);
            });
        });
        self.initDataPipeline();
        self.initAssetPipeline();

        self.server.listen(self.serverConfig.httpPort);
        console.log(`Koa server is now listening on port ${self.serverConfig.httpPort}`);
        self.server.on('error', (err) => {
            console.log(`Koa error: ${util.inspect(err)}`) //must pass all errors to hbLogger or it wont reach log server
        });
    },

    cachedServerSocketSends: {}, // {`change:${message.data.absKey}`: JSON string data, etc...} Used by fauxSocket to hold data changes in local storage until the client(s) sends it's next get request for it.
    initDataPipeline() {
        const self = uiServer;
        if (false) { // JWW TODO - add a cli arg to toggle
            // Make a route to accept incoming WebSocket messages
            self.server.ws.use((ctx, next) => {
                console.log('New socket connection.');
                ctx.websocket.on('message', (messageJson) => { // messages are JSON with attrs "channel" and "data"
                    console.log(`New socket message: ${messageJson}`);
                    let message;
                    try {
                        message = JSON.parse(messageJson);
                    } catch (error) {
                        console.warn(`Invalid JSON passed to WebSocket. ${messageJson}`);
                        return next(ctx);
                    }
                    self.receiveSocketMessage(message, ctx.websocket);
                });
                return next(ctx);
            });
        } else {
            // Make a route for "faux socket" requests
            self.server.use(async (ctx, next) => {
                if (!/^\/fauxSocket.js\?/.test(ctx.request.url)) return next(ctx);
                let message;
                try {
                    message = JSON.parse(ctx.request.query.message);
                } catch (error) {
                    console.warn(`Invalid JSON passed to fauxSocket endpoint. Url: ${ctx.request.url}`);
                    return next(ctx);
                }
                ctx.type = 'application/javascript';
                //ctx.set('Cache-Control', 'no-cache');

                // Scenario 1
                if (self.cachedServerSocketSends[message.channel]) {
                    // Looks like the uiServer is already listening for changes to this redis key and storing locally to self.cachedServerSocketSends. Respond immediately.
                    ctx.body = self.cachedServerSocketSends[message.channel];
                    return;
                }

                // Scenario 2
                const sendPromise = new Promise( (resolve, reject) => {
                    let thisFauxSocketObj = { // JWW todo - creating a new thisFauxSocketObj for every request is a memory leak
                        send: (responseJson) => {
                            if (thisFauxSocketObj.wasResolved) {
                                // Because logic below treats this like a socket, it may call this send function more than once (in an attempt to push data to the client). When that occurs,
                                // we will instead set the new data to our local cachedServerSocketSends object so it's prepped for when the client sends another get request for it (see Scenario 1 above).
                                const message = JSON.parse(responseJson);
                                self.cachedServerSocketSends[message.channel] = responseJson;
                            }
                            resolve(responseJson);
                            thisFauxSocketObj.wasResolved = true;
                        },
                        wasResolved: false
                    };
                    const foundChannelRoute = self.receiveSocketMessage(message, thisFauxSocketObj);
                    if (!foundChannelRoute) {
                        thisFauxSocketObj = null;
                        resolve(null);
                    }
                });
                const responseJson = await sendPromise;
                ctx.body = responseJson;
            });
        }
    },

    initAssetPipeline() {
        const self = uiServer;

        // /////////////
        // Serve static assets. Views, styles, utils, third party packages.

        // Now check the incoming request url against our routeProxies defined above.
        // Manually alter the url if we find a match then pass it along.
        if (self.routeProxies) {
            self.server.use((ctx, next) => {
                const request = ctx.request;
                let matchedRouteProxy;
                _.each(self.routeProxies, (routeProxy, index) => {
                    if (request.url.indexOf(routeProxy.target) === 0) matchedRouteProxy = routeProxy; // uses the last match
                });
                if(!matchedRouteProxy) return next();
                console.log(`Incoming request for ${request.url} matches routeProxy: ${matchedRouteProxy.target} -> ${matchedRouteProxy.redirect}`);
                request.url = request.url.replace(matchedRouteProxy.target, matchedRouteProxy.redirect);
                //Now also check if we should append and extension to the request.url (using applyExtension supplied in routing config above)
                if(matchedRouteProxy.applyExtension && request.url.slice(matchedRouteProxy.applyExtension.length*-1) !== matchedRouteProxy.applyExtension){ //don't append if it's already there
                    request.url = request.url + matchedRouteProxy.applyExtension;
                }
                return next();
            });
        }

        // Now our react components (views)
        self.server.use(koaJsx(path.join(self.serverConfig.rootDir, 'ui', 'views'), { maxage: 1000 })); // TEMP DEV TODO cache maxage

        // Next we check for radium styles defined as js files in views/styles.
        self.server.use(koaStatic(path.join(self.serverConfig.rootDir, 'ui', 'views', 'styles'), { maxage: 1000 }));

        // Then our utils
        self.server.use(koaStatic(path.join(self.serverConfig.rootDir, 'ui', 'helpers'), { maxage: 1000 }));

        // Check if the incoming request is for a node_modules library. If so, correct it's alias path to the actualy js file path,
        // and we also need to run it through webpack so it can be served as an ES module to the browser.
        self.server.use(async (ctx, next) => {
            if (!self.bareModuleMap || !self.bareModuleMap[ctx.request.url]) return next();
            //console.log(util.inspect(ctx, {depth: 10}))
            const bareModulePath = path.resolve(self.serverConfig.rootDir, self.bareModuleMap[ctx.request.url].slice(1)); //remove leading slash
            const moduleFileText = await self.packToEsModule(bareModulePath, ctx.request.url);
            ctx.body = moduleFileText;
            ctx.type = 'application/javascript';
        });

        // If the request didn't match static resources, then we will assume they just
        // landed at our root url, and they need hbLayout which opens a socket and loads entry point.
        self.server.use((ctx, next) => {
            const baseLayoutPath = path.join('ui', 'views', 'hbLayout.html'); //koaSend uses rel paths: https://github.com/koajs/send#root-path
            console.log(`Serving hbLayout to new client: ${baseLayoutPath}`);
            return koaSend(ctx, baseLayoutPath);
        });
    }, // initAssetPipeline

    changeEventThrottle: 2000, // wait time between emission of model changes to client(s)
    changeEventTstamps: {}, //for keeping track of socket emissions per channel
    receiveSocketMessage(message, socket) { // returns bool. true if a route was found for message channel.
        const self = uiServer;

        if (message.channel === 'viewRequest') {
            console.log(`Incoming socket view path request: ${message.data.absKey}`);
            // This is how the front end gets populated with html (via react components).
            // The client requests the file paths by sending the absKey then dynamically adds them to the page.
            self.redisClient.get(message.data.absKey, (gotObj) => {
                if (!gotObj) return;
                if (!gotObj.ui || !gotObj.ui.viewPath) {
                    console.log(`Could not match redis data with a view (${message.data.absKey}).`);
                    return;
                }
                socket.send(JSON.stringify({
                    channel: 'viewResponse',
                    data: {
                        absKey: message.data.absKey,
                        targetEl: message.data.targetEl,
                        viewPath: gotObj.ui.viewPath,
                    },
                }));
            });
            return true;
        } // end if (message.channel === 'viewRequest')

        if (message.channel === 'populateView') {
            const keySpaceSubChannel = `__keyspace@0__:${message.data.absKey}`;
            const modelChangeEventName = `change:${message.data.absKey}`;

            // Send data right away, then re-send any time it changes.
            self.redisClient.get(message.data.absKey, (gotObj) => {
                if (!gotObj) return;
                socket.send(JSON.stringify({ // Manually send once right away to populate view
                    channel: modelChangeEventName,
                    data: gotObj,
                }));
            });

            self.redisClient.on('message', (channel, action) => {
                if (action !== 'set' || channel !== keySpaceSubChannel) return;

                const eventUid = keySpaceSubChannel;
                const now = Date.now();
                if (!self.changeEventTstamps[eventUid]) self.changeEventTstamps[eventUid] = now;
                if (self.changeEventTstamps[eventUid] + self.changeEventThrottle > now) return;
                self.changeEventTstamps[eventUid] = now;

                self.redisClient.get(message.data.absKey, (gotObj) => {
                    if (!gotObj) return;
                    socket.send(JSON.stringify({ // And send again everytime the model changes on server
                        channel: modelChangeEventName,
                        data: gotObj,
                    }));
                });
            });
            self.redisClient.subscribe(keySpaceSubChannel);
            return true;
        } // end if (message.channel === 'populateView')

        // If this message didn't match any of the above main UI rendering channels, pass it along to the socket
        // response utils which hold logic for more specific channels.
        if (typeof self.hbClientSocketDbResponses_admin[message.channel] === 'function') {
            self.hbClientSocketDbResponses_admin[message.channel](message, socket);
            return true;
        }

        return false;
    }, // end receiveSocketMessage

    packedEsModuleCache: {}, //save the compiled module strings in live memory for fast cache
    packToEsModule(bareModulePath, requestedPath){ //requestedPath is the exact string declared in the import statement: import react from "node_modules/react"
        const self = uiServer;
        const snakeToCamel = (str) => str.replace(/([-_][a-z])/g, (group) => {
            return group.toUpperCase().replace('-', '').replace('_', '')
        });
        const requestedLibName = snakeToCamel(requestedPath.split('/').pop());

        return new Promise( (resolve, reject) => {
            if(self.packedEsModuleCache[bareModulePath]) {
                console.log(`Found a cached version of requested node_module: ${bareModulePath}`);
                resolve(self.packedEsModuleCache[bareModulePath]); //found cached entry
                return;
            }
            const compiledPath = path.resolve(self.serverConfig.rootDir);
            const compiledFilename = `bareModule_${Date.now()}.js`;
            console.log(`Now attempting to serve request for a node_module: ${bareModulePath}`);

            if(requestedPath.search(/\.css$/) !== -1) {
                // Looks like this was an ES module request for a CSS file - wrap the css content in JS that will auto inject it to the page
                fs.readFile(bareModulePath, (err, cssText) => {
                    const esModuleText = `const injectCss = () => {
                        let styleEl = document.createElement('style');
                        styleEl.innerHTML = "${cssText}";
                        document.body.appendChild(styleEl);
                    };
                    injectCss();
                    export default injectCss;`.replace(/(\r\n|\n|\r)/gm, ""); //remove linebreaks
                    console.log(`Compiled CSS into ES module format: ${bareModulePath}`);
                    resolve(esModuleText);
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
                    //const esModuleText = compiledText;
                    self.packedEsModuleCache[bareModulePath] = esModuleText;
                    console.log(`Compiled node_modules asset into ES module format: ${bareModulePath}`); // -> ${esModuleText}`);
                    resolve(esModuleText);

                    fs.unlink(compiledFilePath, (err) => {
                        if(err) console.log(err);
                        fs.unlink(compiledFilePath.replace('.js', '.js.LICENSE.txt'), () => {});
                    });
                });

            }); //end webpack
        }); //end return new Promise

    }, //end webpackCompileAsset

    redisClient: null,
    initRedisClient(cback) {
        const self = uiServer;
        self.redisClient = new RedisClient({
            onConnect: (client) => {
                console.log('Connected new redis client for ui server.');
                if (cback) cback();
            }
        });
    }

}; // end uiServer

uiServer.init();
export default uiServer;
