import socketViewRequests from './hbClientSocketViewRequests.js';
import socketViewResponses from './hbClientSocketViewResponses.js';

// All new clients receive this file first thing. This sets up a socket connection
// and socket events for view/template requests.
var hbClient = {

    serverAddress: window.location.host,
    socket: null,

    fauxSocketPollIntervalLength: 5000,
    fauxSocketPollIntervals: [],

    //fauxSocketCurBacktrackPosition: {}, // object holds all message channels which are currently in backtrack mode (keys) and the position in history that they are currently attempting to recover from cdn (value) {'change:foo': 234345624, etc...}
    fauxSocketBacktrackingLeastStaleTstamp: {}, // object holds all message channels which were previously in backtrack mode (keys) and the position in history which returned a 200 response to recover data from cdn (value) {'change:foo': 234345624, etc...}

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
                    const dataChangeMessageChannel = `change:${messageObj.data.absKey}`;
                    const dataChangeMessage = {
                        channel: dataChangeMessageChannel,
                        tstamp: Date.now() // cache buster (set inside interval to a denomination of fauxSocketPollIntervalLength).
                    }
                    if (hbClient.fauxSocketPollIntervals[dataChangeMessage.channel]) return;
                    hbClient.fauxSocketPollIntervals[dataChangeMessage.channel] = setInterval( () => {
                        const now = Date.now();
                        dataChangeMessage.tstamp  = now - (now % hbClient.fauxSocketPollIntervalLength)
                        hbClient.sendFauxSocketMessage(dataChangeMessage, (resMsg, reqStatus) => {
                            if ((!resMsg || reqStatus.toString()[0] !== '2') && !hbClient.fauxSocketBacktrackingLeastStaleTstamp[dataChangeMessage.channel]) {
                                console.log(`Faux socket received a failure response code (${reqStatus})`);
                                hbClient.initFauxSocketBacktrack(dataChangeMessage);
                            }
                        });
                    }, hbClient.fauxSocketPollIntervalLength);
                }
            }
        };
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
        // now that the client has a socket connection with the server, manually
        // ping through that socket to load the landing url.
        const landingUrl = window.location.pathname.replace('.html', '');
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

    initFauxSocketBacktrack(failedSocketReqMsg, backtrackStrategy) {
        // When we initFauxSocketBacktrack, our fauxSocketPollIntervals will continue to send requests for new data using the bracketed timstamp cache buster, BUT we
        // will ALSO send requests for data backwards in time. It will keep doing this until it gets a 200 response - meaning it located
        // the most recent successful response which was cached on CDN - serving this least-stale content is a temporary stop gap until the origin server comes back online.
        if (!failedSocketReqMsg || !failedSocketReqMsg.tstamp) return;

        if (!hbClient.fauxSocketBacktrackingLeastStaleTstamp[failedSocketReqMsg.channel]) {
            hbClient.fauxSocketBacktrackingLeastStaleTstamp[failedSocketReqMsg.channel] = 'pending';
            console.log(`Origin server sent a non 200 response to our faux socket. Will now init backtracking channel ${failedSocketReqMsg.channel} to find the least stale data set which is cached on CDN...`);
        }

        backtrackStrategy = backtrackStrategy || {
            curStep: 1,
            curStepTries: 0,
            lastTestedReqMsg: null,
            '1': (prevTestReqMsg, self) => {
                // Step back in time by ${backStepInterval} ms until we reach the first 200 response.
                const backStepInterval = 600000; // 10 minutes
                const maxSteps = 24; // 4 hours
                let nextTstamp = prevTestReqMsg.tstamp - backStepInterval;
                nextTstamp = nextTstamp - (nextTstamp % hbClient.fauxSocketPollIntervalLength);
                ++self.curStepTries;
                if (self.curStepTries > maxSteps) return null;
                self.lastTestedReqMsg = prevTestReqMsg;
                return nextTstamp;
            },
            '1-test': (curTestReqMsg, reqStatusCode, self) => {
                let succesTstamp = false;
                if (reqStatusCode === 200) {
                    succesTstamp = curTestReqMsg.tstamp;
                    console.log(`Tracked backward ${self.curStepTries*10} minutes to recover cached CDN data for fauxSocket req:`, curTestReqMsg);
                }
                return succesTstamp;
            },
            '2': (prevTestReqMsg, self) => {
                // Step forward in time by ${forwardStepInterval} ms until we reach the first non-200 response.
                const forwardStepInterval = 60000; // 1 minute
                const maxSteps = 10; // 10 minutes
                let nextTstamp = prevTestReqMsg.tstamp + forwardStepInterval;
                nextTstamp = nextTstamp - (nextTstamp % hbClient.fauxSocketPollIntervalLength);
                ++self.curStepTries;
                if (self.curStepTries > maxSteps) return null;
                self.lastTestedReqMsg = prevTestReqMsg;
                return nextTstamp;
            },
            '2-test': (curTestReqMsg, reqStatusCode, self) => {
                let succesTstamp = false;
                if (reqStatusCode !== 200) {
                    succesTstamp = self.lastTestedReqMsg.tstamp;
                    console.log(`A least-stale CDN cache was located at tstamp ${succesTstamp} for fauxSocket req:`, self.lastTestedReqMsg);
                }
                return succesTstamp;
            },
        };

        const backTrackedSocketReqMsg = {...failedSocketReqMsg};
        const nextBackTrackTstamp = backtrackStrategy[backtrackStrategy.curStep](backTrackedSocketReqMsg, backtrackStrategy);
        if (!nextBackTrackTstamp) {
            console.log('Failed to backtrack to cached data for message:', backTrackedSocketReqMsg);
            return;
        }

        backTrackedSocketReqMsg.tstamp = nextBackTrackTstamp
        console.log(`Sending backtracked faux socket message (step #${backtrackStrategy.curStep}, attempt #${backtrackStrategy.curStepTries}):`, backTrackedSocketReqMsg);
        hbClient.sendFauxSocketMessage(backTrackedSocketReqMsg, (resMsg, reqStatus) => {
            if (backtrackStrategy[`${backtrackStrategy.curStep}-test`](backTrackedSocketReqMsg, reqStatus, backtrackStrategy)) {
                ++backtrackStrategy.curStep;
                backtrackStrategy.curStepTries = 0;
            }
            if (backtrackStrategy[backtrackStrategy.curStep]) {
                hbClient.initFauxSocketBacktrack(backTrackedSocketReqMsg, backtrackStrategy);
            } else {
                console.log(`Finished backtracking to least-stale CDN content found here:`, backTrackedSocketReqMsg);
                hbClient.fauxSocketBacktrackingLeastStaleTstamp[backTrackedSocketReqMsg.channel] = backTrackedSocketReqMsg.tstamp;
            }
        });
    },

}; // end hbClient

hbClient.init();
export default hbClient;
