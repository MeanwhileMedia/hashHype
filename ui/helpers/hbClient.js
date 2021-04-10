import socketViewRequests from './hbClientSocketViewRequests';
import socketViewResponses from './hbClientSocketViewResponses';

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
            send: (messageJson) => {
                hbClient.sendFauxSocketMessage(messageJson);
                const message = JSON.parse(messageJson);
                // For certain message channels, we will continue to poll the server for data changes (mimicking how a real server WebSocket would push data to us)
                if (message.channel === 'populateView') { // only if message json channel === 'populateView'
                    // Keep hitting the fauxSocket endpoint with message channel "change:redis:key" and send through to receiveMessage with same channel
                    const dataChangeMessage = {
                        channel: `change:${message.data.absKey}`,
                        tstamp: Date.now() // cache buster (set inside interval to a denominations of fauxSocketPollIntervalLength).
                    }
                    if (hbClient.fauxSocketPollIntervals[dataChangeMessage.channel]) return;
                    hbClient.fauxSocketPollIntervals[dataChangeMessage.channel] = setInterval( () => {
                        const now = Date.now();
                        dataChangeMessage.tstamp  = now - (now % hbClient.fauxSocketPollIntervalLength)
                        const dataChangeMessageJson = JSON.stringify(dataChangeMessage);
                        hbClient.sendFauxSocketMessage(dataChangeMessageJson);
                    }, hbClient.fauxSocketPollIntervalLength);
                }
            }
        };
        hbClient.loadLandingView();
    },
    sendFauxSocketMessage(messageJson) {
        // Example GET request (where the message param is JSON): serverAddress.com/fauxSocket?message={"channel": "viewRequest", "data": {"absKey":"redis:key","targetEl":".containerEl"}}
        // Example response body (JSON): {channel: 'viewResponse', data: {viewPath: jsAssetPath, absKey:"redis:key", targetEl: ".containerEl" }}
        const httpRequest = new XMLHttpRequest();
        httpRequest.onreadystatechange = function(){
            if (httpRequest.readyState !== XMLHttpRequest.DONE || httpRequest.status !== 200) return;
            const message = JSON.parse(httpRequest.response);
            socketViewResponses.receiveMessage(message);
        };
        httpRequest.open('GET', `/fauxSocket.js?message=${messageJson}`, true); // fauxSocket.js endpoint acts as JS to optimize CDN caching. However, it's response body is actually a JSON string.
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
        hbClient.socket.addEventListener('message', (messageJson) => {
            const message = JSON.parse(messageJson.data);
            socketViewResponses.receiveMessage(message);
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


}; // end hbClient

hbClient.init();
export default hbClient;
