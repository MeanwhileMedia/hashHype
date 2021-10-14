import fs from 'fs';
import util from 'util';
import path from 'path';
import https from 'https';
import webpack from 'webpack';
import Koa from 'koa';
import koaConvert from 'koa-convert';
import koaFavicon from 'koa-favicon';
import koaWebsocket from 'koa-websocket';
import koaStatic from 'koa-static';
import hbServeJs from '../utils/hbServeJs.js';
import hbServeHtml from '../utils/hbServeHtml.js';
import HbClientSocketDbResponses_admin from '../utils/hbClientSocketDbResponses-admin.js';
import NodeMailer from '../utils/nodeMailer.js';
import RedisClient from '../utils/redisClient.js';
import hbCodeChecker from '../utils/hbCodeChecker.js';

// For self-signed certificates
const pathToSslKey = path.resolve(process.cwd(), 'utils/certs/MeanwhileMedia.key');
const pathToSslCert = path.resolve(process.cwd(), 'utils/certs/MeanwhileMedia.crt');
// For certbot signed ssl certs:
// const pathToSslKey = path.resolve(process.cwd(), 'utils/certs/meanwhile.media/privkey1.pem');
// const pathToSslCert = path.resolve(process.cwd(), 'utils/certs/meanwhile.media/cert1.pem');
// const pathToSslCa = path.resolve(process.cwd(), 'utils/certs/meanwhile.media/chain1.pem');


// Koa handles all request routing and middleware for serving static files. koa.io holds our
// socket.io server which links our views to models. Both are defined and initialized here.
const uiServer = {

    serverConfig: {
        rootDir: process.cwd(), //the project root
        httpsPort: 8080 // this will be the exposed server port regardless of what machine the uiServer is run on
    },

    // ES module imports in browser do not yet support "bare" module imports. Maintain a map here, and use a custom syntax to import node_modules.
    // Not yet supported: 'import _ from "underscore"'
    // Current polyfill: 'import _ from "/node_modules/underscore"'
    // See https://medium.com/webpack/the-state-of-javascript-modules-4636d1774358
    bareModuleMap: {
        '/node_modules/react': '/node_modules/react/cjs/react.production.min.js',
        '/node_modules/react-dom': '/node_modules/react-dom/cjs/react-dom.production.min.js',
        '/node_modules/d3': '/node_modules/d3/dist/d3.min.js',
        '/node_modules/hammerjs': '/node_modules/hammerjs/hammer.min.js',
        '/node_modules/radium': '/node_modules/radium/dist/radium.min.js',
        '/node_modules/throttle-debounce': '/node_modules/throttle-debounce/esm/index.js',
        '/node_modules/highlight': '/node_modules/highlight.js/lib/core.js',
        '/node_modules/highlight/js': '/node_modules/highlight.js/lib/languages/javascript.js',
        '/node_modules/highlight/jsStyles.css': '/node_modules/highlight.js/styles/atom-one-dark.css'
    },

    // In defining our koa middleware (below), we expose specific directories to public requests.
    // As a result, the url 'site.com/publicUtil.js' actually resolves to /utils/public/publicUtil.js. (/utils/public/ is one of the exposed directories at a 'root' url path)
    // This causes our require paths to be out of sync between server and client modules. To compensate,
    // we are setting "routeProxies" to support consistent paths, and koa's flat asset pipeline below.
    routeProxies: [
        { target: '/ui/views/', redirect: '/' }, // applyExtension will always be appended to request.url - it allows ES import paths without extensions (for consistency with backend)
        { target: '/ui/views/styles/', redirect: '/' },
        { target: '/ui/helpers/', redirect: '/' },
        { target: '/ui/layout/', redirect: '/' },
        { target: '/ui/layout/styles/', redirect: '/styles/' },
        { target: '/ui/images/', redirect: '/' },
    ],

    init() {
        uiServer.initRedisClient( () => {
            uiServer.initKoaServer();
            uiServer.hbClientSocketDbResponses_admin = new HbClientSocketDbResponses_admin({
                redisClient: uiServer.redisClient
            });
            uiServer.nodeMailer = new NodeMailer('joeATmeanwhile');
        });
    }, // init

    initKoaServer() {
        const self = uiServer;
        const httpsOpts = {
            key: fs.readFileSync(pathToSslKey, 'utf8').toString(),
            cert: fs.readFileSync(pathToSslCert, 'utf8').toString(),
            // ca: fs.readFileSync(pathToSslCa, 'utf8').toString(), // For certbot signed ssl certs:
        };

        if (false) { // JWW TODO - add a cli arg to toggle
            const wsOpts = {};
            self.server = koaWebsocket(new Koa(), wsOpts, httpsOpts);
            self.server.listen(self.serverConfig.httpsPort);
        } else {
            self.server = new Koa();
            https.createServer(httpsOpts, self.server.callback()).listen(self.serverConfig.httpsPort);
        }
        //self.server.listen(self.serverConfig.httpsPort);
        console.log(`Koa server is now listening on port ${self.serverConfig.httpsPort}`);

        self.server.use((ctx, next) => {
            const start = new Date(); // response time logger
            return next().then(() => {
                const ms = new Date() - start;
                console.log(`${ctx.request.method} ${ctx.request.url} - ${ms} ms`);
            });
        });
        self.initDataPipeline();
        self.initAssetPipeline();
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
                ctx.websocket.on('message', (encodedMessageStr) => { // messages are baase64 encoded JSON with attrs "channel" and "data"
                    self.receiveSocketMessage(encodedMessageStr, ctx.websocket);
                });
                return next(ctx);
            });
        } else {
            // Make a route for "faux socket" requests
            self.server.use(async (ctx, next) => {
                if (!/^\/fauxSocket.js\?/.test(ctx.request.url)) return next(ctx);
                ctx.type = 'application/javascript';
                //ctx.set('Cache-Control', 'no-cache');

                const encodedMessageStr = ctx.request.query.message;
                const message = self.decodeSocketMessage(encodedMessageStr);
                if (!message || !message.channel) return;

                // Scenario 1
                if (self.cachedServerSocketSends[message.channel]) {
                    // Looks like the uiServer is already listening for changes to this redis key and storing locally to self.cachedServerSocketSends. Respond immediately.
                    ctx.body = self.cachedServerSocketSends[message.channel];
                    return;
                }

                // Scenario 2
                const sendPromise = new Promise( (resolve, reject) => {
                    let thisFauxSocketObj = { // JWW todo - creating a new thisFauxSocketObj for every request is a memory leak
                        send: (encodedResponseStr) => {
                            if (thisFauxSocketObj.wasResolved) {
                                // Because logic below treats this like a socket, it may call this send function more than once (in an attempt to push data to the client). When that occurs,
                                // we will instead set the new data to our local cachedServerSocketSends object so it's prepped for when the client sends another get request for it (see Scenario 1 above).
                                const responseObj = self.decodeSocketMessage(encodedResponseStr);
                                self.cachedServerSocketSends[responseObj.channel] = encodedResponseStr;
                            }
                            resolve(encodedResponseStr);
                            thisFauxSocketObj.wasResolved = true;
                        },
                        wasResolved: false
                    };
                    const foundChannelRoute = self.receiveSocketMessage(encodedMessageStr, thisFauxSocketObj);
                    if (!foundChannelRoute) {
                        thisFauxSocketObj = null;
                        resolve(null);
                    }
                });
                const encodedResponse = await sendPromise;
                ctx.body = encodedResponse;
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
                self.routeProxies.forEach((routeProxy, index) => {
                    if (request.url.indexOf(routeProxy.target) === 0) matchedRouteProxy = routeProxy; // uses the last match
                });
                if(!matchedRouteProxy) return next();
                console.log(`Incoming request for ${request.url} matches routeProxy: ${matchedRouteProxy.target} -> ${matchedRouteProxy.redirect}`);
                request.url = request.url.replace(matchedRouteProxy.target, matchedRouteProxy.redirect);
                return next();
            });
        }

        // Now our react components (views)
        self.server.use(hbServeJs(path.join(self.serverConfig.rootDir, 'ui', 'views'), { maxage: 1000 })); // maxage is in ms  TEMP DEV TODO revisit our maxage setting

        // Next we check for radium styles defined as js files in views/styles.
        self.server.use(hbServeJs(path.join(self.serverConfig.rootDir, 'ui', 'views', 'styles'), { maxage: 1000 }));

        // Then our utils
        self.server.use(hbServeJs(path.join(self.serverConfig.rootDir, 'ui', 'helpers'), { maxage: 1000 }));

        // Check if the incoming request is for a node_modules library. If so, correct it's alias path to the actualy js file path,
        // and we also need to run it through webpack so it can be served as an ES module to the browser.
        self.server.use(async (ctx, next) => { // JWW todo - move this into a middleware file
            if (!self.bareModuleMap || !self.bareModuleMap[ctx.request.url]) return next();
            //console.log(util.inspect(ctx, {depth: 10}))
            const bareModulePath = path.resolve(self.serverConfig.rootDir, self.bareModuleMap[ctx.request.url].slice(1)); //remove leading slash
            const moduleFileText = await self.packNodeModuleToEsModule(bareModulePath, ctx.request.url);
            ctx.body = moduleFileText;
            ctx.type = 'application/javascript';
        });

        // Serve html from our ui/layout directory. All html is compiled in hbServeHtml which adds reqModifier to script tags.
        self.server.use(hbServeHtml(path.join(self.serverConfig.rootDir, 'ui', 'layout'), { maxage: 1000 }));

        // Next, add support for static layout files that didn't match as HTML (like hbLayout.css). These files are not compiled.
        self.server.use(koaStatic(path.join(self.serverConfig.rootDir, 'ui', 'layout'), { maxage: 1000 }));

        // favicon
        self.server.use(koaFavicon(path.join(self.serverConfig.rootDir, 'ui', 'images', 'favicon.ico'), { maxage: 1000 }));

        // Add a route for static image files
        self.server.use(koaStatic(path.join(self.serverConfig.rootDir, 'ui', 'images'), { maxage: 1000 }));

        // If the request didn't match static resources, then we will assume they just
        // landed at our root url, and they need hbLayout which loads entry point.
        self.server.use((ctx, next) => {
            console.log(`Serving hbLayout to new client session for entry point: ${ctx.request.url}`);
            self.createOrDeleteLandingCookies(ctx);
            ctx.request.url = 'hbLayout.html';
            return hbServeHtml(path.join(self.serverConfig.rootDir, 'ui', 'layout'), { maxage: 1000 })(ctx, next);
        });
    }, // initAssetPipeline

    createOrDeleteLandingCookies(ctx) {
        // 1. Set all session cookies that will be a part of all future requests (httpOnly)
        // 2. Set a reqModifier cookie based on below outcome (httpOnly: false). during FE code compile, this string is appended
        //    to all future module import based file requests. It is a dynamic cache buster. See hbServeJs.js
        const futureRequestModifiers = [];
        const httpCookieSettings = {
            secure: true,
            httpOnly: true,
            sameSite: 'strict',
            overwrite: true
        };
        // First determine if this user gets admin access
        if (ctx.query.fEAdmin && hbCodeChecker.shouldServeFEAdminAsset(ctx, ctx.query.fEAdmin).shouldServe) {
            ctx.cookies.set('fEAdmin', ctx.query.fEAdmin, httpCookieSettings);
            futureRequestModifiers.push('fEAdmin');
        } else {
            ctx.cookies.set('fEAdmin'); // empty value deletes the cookie
        }
        // Now set the reqModifier cookie
        if (futureRequestModifiers.length > 0) {
            ctx.cookies.set('reqModifier', JSON.stringify(futureRequestModifiers), httpCookieSettings);
        } else {
            ctx.cookies.set('reqModifier'); // empty value deletes the cookie
        }
    },



    changeEventThrottle: 2000, // wait time between emission of model changes to client(s)
    changeEventTstamps: {}, //for keeping track of socket emissions per channel
    receiveSocketMessage(encodedMessageStr, socket) { // returns bool. true if a route was found for message channel.
        const self = uiServer;
        const message = self.decodeSocketMessage(encodedMessageStr);
        if (!message || !message.channel) return false;
        console.log(`Incoming socket message:`, message);

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
                const encodedMessage = self.encodeSocketMessage({
                    channel: 'viewResponse',
                    data: {
                        absKey: message.data.absKey,
                        targetEl: message.data.targetEl,
                        viewPath: gotObj.ui.viewPath,
                    },
                });
                if (!encodedMessage) return;
                socket.send(encodedMessage);
            });
            return true;
        } // end if (message.channel === 'viewRequest')

        if (message.channel === 'populateView') {
            const keySpaceSubChannel = `__keyspace@0__:${message.data.absKey}`;
            const modelChangeEventName = `change:${message.data.absKey}`;

            // Send data right away, then re-send any time it changes.
            self.redisClient.get(message.data.absKey, (gotObj) => {
                if (!gotObj) return;
                const encodedMessage = self.encodeSocketMessage({
                    channel: modelChangeEventName,
                    data: gotObj,
                });
                if (!encodedMessage) return;
                socket.send(encodedMessage); // Manually send once right away to populate view
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
                    const encodedMessage = self.encodeSocketMessage({ // And send again everytime the model changes on server
                        channel: modelChangeEventName,
                        data: gotObj,
                    });
                    if (!encodedMessage) return;
                    socket.send(encodedMessage);
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
        if (typeof self.nodeMailer[message.channel] === 'function') {
            self.nodeMailer[message.channel](message, socket);
            return true;
        }

        return false;
    }, // end receiveSocketMessage

    encodeSocketMessage(messageObj) {
        if (typeof messageObj !== 'object') {
            console.warn('Could not encodeSocketMessage. messageObj was not a valid object.');
            return null;
        }
        let buff;
        let json;
        let encodedMessage;
        try {
            json = JSON.stringify(messageObj);
            buff = new Buffer(json);
            encodedMessage = buff.toString('base64');
        } catch (e) {
            console.warn(`Could not encodeSocketMessage`, e, messageObj);
            return null;
        }
        return encodedMessage;
    },
    decodeSocketMessage(encodedMessageStr) {
        if (typeof encodedMessageStr !== 'string') {
            console.warn('Could not decodeSocketMessage. encodedMessageStr was not a valid string.');
            return null;
        }
        let buff;
        let json;
        let decodedMessage;
        try {
            buff = new Buffer(encodedMessageStr, 'base64');
            json = buff.toString('utf8');
            decodedMessage = JSON.parse(json);
        } catch (e) {
            console.warn(`Could not decodeSocketMessage`, e, json);
            return null;
        }
        return decodedMessage;
    },

    packNodeModuleToEsModule(bareModulePath, requestedPath){ //requestedPath is the exact string declared in the import statement: import react from "node_modules/react"
        const self = uiServer;
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
                const compiledPath = path.resolve(self.serverConfig.rootDir);
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
                        // self.packedEsModuleCache[bareModulePath] = esModuleText;
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
            if (cback) cback(esModuleText);
        });
    }, // end packNodeModuleCssToEsModule


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
