import React from '/node_modules/react';
import ReactDom from '/node_modules/react-dom';
import socketViewRequests from './hbClientSocketViewRequests.js';

// Client side socket
var hbClientSocketViewResponses = {

  viewInstance: null,
  viewAbsKey: null,

  receiveMessage(message) {
    if (message.channel === 'viewResponse') {
      // We are receiving the path to the view file so we can require it async
      hbClientSocketViewResponses.receiveViewResponse(message);
    }

    if (hbClientSocketViewResponses.activeViewChangeEvents[message.channel]) { // for when message.channel === "change:redis:key"
      hbClientSocketViewResponses.activeViewChangeEvents[message.channel](message);
    }

    if (message.channel == 'status:clientResponse') {
        // this is just a generic response message that doesn't have any followup logic. Just log to console.
        console.log(message.data);
    }
  },

  receiveViewResponse(message) {
    import(message.data.viewPath).then((asyncModule) => {
      const view = asyncModule.default;
      const viewInstance = ReactDom.render(React.createElement(view, null), document.querySelector(message.data.targetEl));
      hbClientSocketViewResponses.initViewChangeListener(message.data.absKey, viewInstance);
    });
  },

  activeViewChangeEvents: {}, // {socketChangeEventName: function to execute upon receipt}
  initViewChangeListener(viewAbsKey, viewInstance) {
    // manually request the model data, and set up a change listener (on the server)
    const socketChangeEventName = `change:${viewAbsKey}`;
    if (hbClientSocketViewResponses.activeViewChangeEvents[socketChangeEventName]) {
      // console.warn(`Blocked an attempt to subscribe to the same socket event twice: ${socketChangeEventName}`);
      return;
    }

    hbClientSocketViewResponses.activeViewChangeEvents[socketChangeEventName] = function (message) {
      // console.log('Model change sent from server. View will now update.', message.data.absKey, message.data);
      if (typeof viewInstance.receiveNewState === 'function') {
        viewInstance.receiveNewState(message.data);
      }
    };
    socketViewRequests.populateView(viewAbsKey);
    console.log(`Listening for view change event: ${socketChangeEventName}`);
  },

}; // end hbClientSocketViewResponses

export default hbClientSocketViewResponses;
