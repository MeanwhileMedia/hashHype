import fs from 'fs';
import util from 'util';
import path from 'path';
import https from 'https';
import yargs from 'yargs';
import Koa from 'koa';
import koaWebsocket from 'koa-websocket';
import koaStatic from 'koa-static';
import hbServeJs from '../utils/hbServeJs.js';
import hbServeNodeModule from '../utils/hbServeNodeModule.js';
import hbServeHtml from '../utils/hbServeHtml.js';
import HbClientSocketDbResponses_admin from '../utils/hbClientSocketDbResponses-admin.js';
import NodeMailer from '../utils/nodeMailer.js';
import RedisClient from '../utils/redisClient.js';
import hbCodeChecker from '../utils/hbCodeChecker.js';

const argv = yargs(process.argv.slice(2)).argv;

// For self-signed certificates
const pathToSslKey = path.resolve(process.cwd(), 'utils/certs/MeanwhileMedia.key');
const pathToSslCert = path.resolve(process.cwd(), 'utils/certs/MeanwhileMedia.crt');

// Koa handles all request routing and middleware for serving static files. koa.io holds our
// socket.io server which links our views to models. Both are defined and initialized here.
const uiServer = {

    serverConfig: {
        rootDir: process.cwd(), //the project root
        httpsPort: 8080, // this will be the exposed server port regardless of what machine the uiServer is run on

        // We let browsers cache files for 10 minutes and CDN cache indefinitely - CDN cache is cleared during a prod deploy.
        cacheControlHeader: `public, max-age=600, s-maxage=31536000` // ms. used when setting cache header 'Cache-Control': `${cacheControlHeader}`
    },

    // ES module imports in browser do not yet support "bare" module imports. Maintain a map here, and use a custom syntax to import node_modules.
    // Not yet supported: 'import _ from "underscore"'
    // Current polyfill: 'import _ from "/node_modules/underscore"'
    // These all go through hbServeNodeModule upon path match.
    bareModuleMap: {
        '/node_modules/react': '/node_modules/react/cjs/react.production.min.js',
        '/node_modules/react-dom': '/node_modules/react-dom/cjs/react-dom.production.min.js',
        '/node_modules/d3': '/node_modules/d3/dist/d3.min.js',
        '/node_modules/hammerjs': '/node_modules/hammerjs/hammer.min.js',
        '/node_modules/radium': '/node_modules/radium/dist/radium.min.js',
        '/node_modules/throttle-debounce': '/node_modules/throttle-debounce/esm/index.js',
        '/node_modules/highlight': '/node_modules/highlight.js/lib/core.js',
        '/node_modules/highlight/js': '/node_modules/highlight.js/lib/languages/javascript.js',
        '/node_modules/highlight/jsStyles.css': '/node_modules/highlight.js/styles/atom-one-dark.css',

        '/node_modules/@material-icons/data_saver_on.svg': '/node_modules/@material-icons/svg/svg/data_saver_on/baseline.svg',
        '/node_modules/@material-icons/settings.svg': '/node_modules/@material-icons/svg/svg/settings/baseline.svg',
        '/node_modules/@material-icons/account_circle.svg': '/node_modules/@material-icons/svg/svg/account_circle/baseline.svg',
        '/node_modules/@material-icons/cancel_presentation.svg': '/node_modules/@material-icons/svg/svg/cancel_presentation/baseline.svg',
        '/node_modules/@material-icons/error.svg': '/node_modules/@material-icons/svg/svg/error/baseline.svg',
        '/node_modules/@material-icons/check_circle_outline.svg': '/node_modules/@material-icons/svg/svg/check_circle_outline/baseline.svg',
        '/node_modules/@material-icons/dangerous.svg': '/node_modules/@material-icons/svg/svg/dangerous/baseline.svg',
        '/node_modules/@material-icons/article.svg': '/node_modules/@material-icons/svg/svg/article/baseline.svg',
        '/node_modules/@material-icons/pie_chart.svg': '/node_modules/@material-icons/svg/svg/pie_chart/baseline.svg',
        '/node_modules/@material-icons/leaderboard.svg': '/node_modules/@material-icons/svg/svg/leaderboard/baseline.svg',
        '/node_modules/@material-icons/place.svg': '/node_modules/@material-icons/svg/svg/place/baseline.svg',
        '/node_modules/@material-icons/info.svg': '/node_modules/@material-icons/svg/svg/info/baseline.svg',
        '/node_modules/@material-icons/arrow_drop_down_circle.svg': '/node_modules/@material-icons/svg/svg/arrow_drop_down_circle/baseline.svg',
    },

    // In defining our koa middleware (below), we expose specific directories to public requests.
    // As a result, the url 'site.com/publicUtil.js' actually resolves to /utils/public/publicUtil.js. (/utils/public/ is one of the exposed directories at a 'root' url path)
    // This causes our require paths to be out of sync between server and client modules. To compensate,
    // we are setting "routeProxies" to support consistent paths, and koa's flat asset pipeline below.
    routeProxies: [
        { target: '/ui/views/', redirect: '/' },
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

        // response time logger
        self.server.use((ctx, next) => {
            const start = new Date();
            return next().then(() => {
                const ms = new Date() - start;
                console.log(`${ctx.request.ip} - ${ctx.request.method} ${ctx.request.url} - ${ms} ms`);
            });
        });

        // Set our 'Cache-Control' header. For simplicity, this is the same for all assets, and a full CDN cache clear is performed during a prod release.
        self.server.use((ctx, next) => {
            ctx.set({
                'Cache-Control': self.serverConfig.cacheControlHeader,
            });
            return next();
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
                    const foundChannelRoute = self.receiveSocketMessage(encodedMessageStr, thisFauxSocketObj, ctx);
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

        // First check the incoming request url against our routeProxies defined above.
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
        self.server.use(hbServeJs(path.join(self.serverConfig.rootDir, 'ui', 'views')));

        // Next we check for radium styles defined as js files in views/styles.
        self.server.use(hbServeJs(path.join(self.serverConfig.rootDir, 'ui', 'views', 'styles')));

        // Then our utils
        self.server.use(hbServeJs(path.join(self.serverConfig.rootDir, 'ui', 'helpers')));

        // Serve files from the node_modules folder, but only if they are mapped above in self.bareModuleMap
        self.server.use(hbServeNodeModule({
            nodeModulesPath: path.join(self.serverConfig.rootDir, 'node_modules'),
            bareModuleMap: self.bareModuleMap,
            redisClient: self.redisClient,
            resOpts: { maxage: self.serverConfig.responseCacheMaxAge }
        }));

        // Serve html from our ui/layout directory. All html is compiled in hbServeHtml which adds reqModifier to script tags.
        self.server.use(hbServeHtml(path.join(self.serverConfig.rootDir, 'ui', 'layout')));

        // Next, add support for static layout files that didn't match as HTML (like hbLayout.css). These files are not compiled.
        self.server.use(koaStatic(path.join(self.serverConfig.rootDir, 'ui', 'layout')));

        // favicon
        self.server.use(koaStatic(path.join(self.serverConfig.rootDir, 'ui', 'images', 'favicon.ico')));

        // Add a route for static image files
        self.server.use(koaStatic(path.join(self.serverConfig.rootDir, 'ui', 'images')));

        // If the request didn't match static resources, then we will assume they just
        // landed at our root url, and they need hbLayout which loads entry point.
        self.server.use((ctx, next) => {
            console.log(`Serving hbLayout to new client session for entry point: ${ctx.request.url}`);
            self.createOrDeleteLandingCookies(ctx);
            ctx.request.url = 'hbLayout.html';
            return hbServeHtml(path.join(self.serverConfig.rootDir, 'ui', 'layout'))(ctx, next);
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
    receiveSocketMessage(encodedMessageStr, socket, koaCtx = null) { // returns bool. true if a route was found for message channel. koaCtx is only defined when using fauxSocket
        const self = uiServer;
        const message = self.decodeSocketMessage(encodedMessageStr);
        if (!message || !message.channel) return false;
        console.log(`Incoming socket message:`, message);

        if (message.channel === 'viewRequest') {
            console.log(`Incoming socket view path request: ${message.data.absKey}`);
            // This is how the front end gets populated with html (via react components).
            // The client requests the file paths by sending the absKey then dynamically adds them to the page.
            self.redisClient.get(message.data.absKey, (gotObj) => {
                if (!gotObj) {
                    console.error(`Could not find redis key ${message.data.absKey} when responding to a viewRequest socket message.`);
                    return;
                }
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
            if (koaCtx) { // koaCtx is only defined when using fauxSocket. For now, it's required to ID an admin user.
                const adminCodeStatus = hbCodeChecker.shouldServeFEAdminAsset(koaCtx);
                if (adminCodeStatus.shouldServe) {
                    console.log(`Forwarding socket message to hbClientSocketDbResponses_admin for admin user ${adminCodeStatus.adminInfo.name}...`);
                    self.hbClientSocketDbResponses_admin[message.channel](message, socket);
                    return true;
                }
            }
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
        let encodedMessage;
        try {
            encodedMessage = encodeURIComponent(JSON.stringify(messageObj));
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
        let decodedMessage;
        try {
            decodedMessage = JSON.parse(decodeURIComponent(encodedMessageStr));
        } catch (e) {
            console.warn(`Could not decodeSocketMessage`, e);
            return null;
        }
        return decodedMessage;
    },

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
