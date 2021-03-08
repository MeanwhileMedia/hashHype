import socketViewRequests from './hbClientSocketViewRequests';
import socketViewResponses from './hbClientSocketViewResponses';

// All new clients receive this file first thing. This sets up a socket connection
// and socket events for view/template requests.
var hbClient = {

  serverAddress: 'localhost:8080',
  socket: null,

  init() {
    window.hbClient = this;
    hbClient.openSocketConnection();
  },

  openSocketConnection() {
    console.log('Opening socket connection with', hbClient.serverAddress);
    // hbClient.socket = socketIo(this.serverAddress)
    hbClient.socket = new WebSocket(`ws://${hbClient.serverAddress}`);
    hbClient.socket.addEventListener('open', (event) => {
      console.log('Successful socket connection with', hbClient.serverAddress);
      hbClient.initSocketListeners();
      hbClient.loadLandingView();
    });
  }, // openSocketConnection


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
