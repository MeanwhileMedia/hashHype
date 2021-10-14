import socketViewRequests from './hbClientSocketViewRequests.js';
import socketViewResponses from './hbClientSocketViewResponses.js';

// All new clients receive this file first thing. This sets up a socket connection
// and socket events for view/template requests.
var hbClient = {

    serverAddress: window.location.host,
    socket: null,

    fauxSocketPollIntervalLength: 5000,
    fauxSocketPollIntervals: [],

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
                hbClient.sendFauxSocketMessage(messageObj);
                // For certain message channels, we will continue to poll the server for data changes (mimicking how a real server WebSocket would push data to us)
                if (messageObj.channel === 'populateView') { // only if message json channel === 'populateView'
                    // Keep hitting the fauxSocket endpoint with message channel "change:redis:key" and send through to receiveMessage with same channel
                    const dataChangeMessage = {
                        channel: `change:${messageObj.data.absKey}`,
                        tstamp: Date.now() // cache buster (set inside interval to a denominations of fauxSocketPollIntervalLength).
                    }
                    if (hbClient.fauxSocketPollIntervals[dataChangeMessage.channel]) return;
                    hbClient.fauxSocketPollIntervals[dataChangeMessage.channel] = setInterval( () => {
                        const now = Date.now();
                        dataChangeMessage.tstamp  = now - (now % hbClient.fauxSocketPollIntervalLength)
                        hbClient.sendFauxSocketMessage(dataChangeMessage);
                    }, hbClient.fauxSocketPollIntervalLength);
                }
            }
        };
        hbClient.loadLandingView();
    },
    sendFauxSocketMessage(messageObj) {
        // Example GET request (where the message param is JSON): serverAddress.com/fauxSocket?message={"channel": "viewRequest", "data": {"absKey":"redis:key","targetEl":".containerEl"}}
        // Example response body (JSON): {channel: 'viewResponse', data: {viewPath: jsAssetPath, absKey:"redis:key", targetEl: ".containerEl" }}
        const encodedMessageStr = hbClient.encodeSocketMessage(messageObj);
        if (!encodedMessageStr) return;
        const httpRequest = new XMLHttpRequest();
        httpRequest.onreadystatechange = function(){
            if (httpRequest.readyState !== XMLHttpRequest.DONE || httpRequest.status !== 200) return;
            const decodedMessage = hbClient.decodeSocketMessage(httpRequest.response);
            if (!decodedMessage) return;
            socketViewResponses.receiveMessage(decodedMessage);
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
        // now that the client has a socket connection with the server, manually
        // ping through that socket to load the landing url.
        const landingUrl = window.location.pathname;
        const absKey = landingUrl.slice(1).replace('_', ':'); //reform with proper redis keyspace delimeters
        socketViewRequests.viewRequest({
            absKey: absKey,
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
        let json;
        let encodedMessage;
        try {
            json = JSON.stringify(messageObj);
            encodedMessage = btoa(json);
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
        let json;
        let decodedMessage;
        try {
            json = atob(encodedMessageStr);
            decodedMessage = JSON.parse(json);
        } catch (e) {
            console.warn(`Could not decodeSocketMessage`, e, json);
            return null;
        }
        return decodedMessage;
    },

}; // end hbClient

hbClient.init();
export default hbClient;
