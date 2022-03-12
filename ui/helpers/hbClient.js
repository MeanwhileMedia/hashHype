import socketViewRequests from './hbClientSocketViewRequests.js';
import socketViewResponses from './hbClientSocketViewResponses.js';

// All new clients receive this file first thing. This sets up a socket connection
// and socket events for view/template requests.
var hbClient = {

    serverAddress: window.location.host,
    socket: null,

    fauxSocketPollIntervalLength: 5000,
    fauxSocketPollIntervals: [],

    // clientSideRedirects will look at the landing URL and it it matches a key, will "redirect" to the val. This redirect
    // is actually a history push state and does not actually send any HTTP redirect codes. This is to avoid impacting performance and seo scores.
    clientSideRedirects: {
        '': 'stats_topComments.html',
        '/': 'stats_topComments.html'
    },

    init() {
        window.hbClient = this;
        console.log('Opening connection with', hbClient.serverAddress);
        hbClient.useCdnFauxSocket(); // a faux "socket" connection (is actually HTTP optimized for prod CDN)
        //hbClient.useRealWebSocket(); // a native websocket - not optimized for prod use
    },

    useCdnFauxSocket() {
        // This hbClient "socket" object mimics the websocket interface but is actually HTTP. This is so that all of our faux socket communication can be cached on CDN.
        // Technically, we should be able to swap between useCdnSocket and useRealWebSocket seamlessly.
        hbClient.socket = {
            send: (messageObj) => {
                // We keep a blacklist of channels which have extra logic involved in this send routine. If this channel doesn't match any of them, just send away immediately and return.
                if (messageObj.channel !== 'populateView') {
                    hbClient.sendFauxSocketMessage(messageObj);
                    return;
                }

                if (messageObj.channel === 'populateView') { // only if message json channel === 'populateView'
                    // Send our request for initial render immediately, BUT it should also have a cache tstamp or else we see a flash of very old data replaced by current data after 5 seconds (on prod CDN).
                    const now = Date.now();
                    messageObj.tstamp = now - (now % hbClient.fauxSocketPollIntervalLength);
                    // for this initial landing view, we are actually going to render data that is 10 minutes old for 2 reasons:
                    // 1. There's a better chance that this data endpoint will already be CDN cached, and we want our page to have meaningful paint asap
                    // 2. Allowing a slight gap between first data, and second data allows our viz to animate just enough to provide visual representation that this is realtime data.
                    messageObj.tstamp = messageObj.tstamp - 600000;
                    hbClient.sendFauxSocketMessage(messageObj);

                    // Keep hitting the fauxSocket endpoint with message channel "change:redis:key" and send through to receiveMessage with same channel (mimicking how a real server WebSocket would push data to us)
                    const dataChangeMessageChannel = `change:${messageObj.data.absKey}`;
                    const dataChangeMessage = {
                        channel: dataChangeMessageChannel,
                        tstamp: now // cache buster (set inside interval to a denomination of fauxSocketPollIntervalLength).
                    }
                    if (hbClient.fauxSocketPollIntervals[dataChangeMessage.channel]) return;
                    hbClient.fauxSocketPollIntervals[dataChangeMessage.channel] = setInterval( () => {
                        const now = Date.now();
                        dataChangeMessage.tstamp  = now - (now % hbClient.fauxSocketPollIntervalLength)
                        hbClient.sendFauxSocketMessage(dataChangeMessage, (resMsg, reqStatus) => {
                            if (!resMsg || reqStatus.toString()[0] !== '2') {
                                console.log(`Faux socket received a failure response code (${reqStatus})`, resMsg);
                            }
                        });
                    }, hbClient.fauxSocketPollIntervalLength);
                }

            } // end send: (messageObj) => {
        }; // end hbClient.socket

        hbClient.loadLandingView();
    },
    sendFauxSocketMessage(messageObj, cback) {
        // Example GET request (where the message param is JSON): serverAddress.com/fauxSocket?message={"channel": "viewRequest", "data": {"absKey":"redis:key","targetEl":".containerEl"}}
        // Example response body (JSON): {channel: 'viewResponse', data: {viewPath: jsAssetPath, absKey:"redis:key", targetEl: ".containerEl" }}
        const encodedMessageStr = hbClient.encodeSocketMessage(messageObj);
        if (!encodedMessageStr) return;
        const httpRequest = new XMLHttpRequest();
        httpRequest.onreadystatechange = function(){
            if (httpRequest.readyState !== XMLHttpRequest.DONE) return;
            if (httpRequest.readyState === XMLHttpRequest.DONE && httpRequest.status !== 200) {
                if (cback) cback(null, httpRequest.status);
                return;
            }
            const decodedMessage = hbClient.decodeSocketMessage(httpRequest.response);
            if (!decodedMessage) return;
            socketViewResponses.receiveMessage(decodedMessage);
            if (cback) cback(decodedMessage, httpRequest.status);
        };
        httpRequest.open('GET', `/fauxSocket.js?message=${encodedMessageStr}`, true); // fauxSocket.js endpoint acts as JS to optimize CDN caching. However, it's response body is actually a JSON string.
        httpRequest.send();
    },

    useRealWebSocket() {
        // Not currently in use but could potentially be reused should we ever revert to native websockets instead of CDN data files
        hbClient.socket = new WebSocket(`ws://${hbClient.serverAddress}`);
        hbClient.socket.addEventListener('open', (event) => {
            console.log('Successful socket connection with', hbClient.serverAddress);
            hbClient.initSocketListeners();
            hbClient.loadLandingView();
        });
    },
    initSocketListeners() {
        hbClient.socket.addEventListener('message', (message) => {
            const decodedMessage = hbClient.decodeSocketMessage(message.data);
            if (!decodedMessage) return;
            socketViewResponses.receiveMessage(decodedMessage);
        });
    }, // initSocketListeners

    loadLandingView() {
        const self = hbClient;
        // now that the client has a socket connection with the server, manually
        // ping through that socket to load the landing url.
        let landingUrl = window.location.pathname.slice(1); // remove preceding slash
        if (self.clientSideRedirects[landingUrl]) {
            landingUrl = self.clientSideRedirects[landingUrl];
            history.pushState({}, document.title, landingUrl);
        }

        let landingAbsKey = landingUrl.replace('.html', '');
        landingAbsKey = landingAbsKey.replace('_', ':'); //reform with proper redis keyspace delimeters
        socketViewRequests.viewRequest({
            absKey: landingAbsKey,
            targetEl: document.querySelector('#main'),
        });
        // Since we are loading this view onto a blank page, the target el must be "main".
        // If the landingUrl points to a view which is not intended to be rendered as a full page,
        // then the server will traverse upward until it finds a parent with a "main" template.
    },

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

}; // end hbClient

hbClient.init();
export default hbClient;
