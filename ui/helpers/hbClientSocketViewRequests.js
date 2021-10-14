// Client side socket
const hbClientSocketViewRequests = {

  viewRequest(args) {
    // args = {targetEl: dom element, absKey: string}
    const elData = args.targetEl.dataset;

    // If no absKey was sent, then pull it off of the elData
    if (!args.absKey) {
      args.absKey = elData.viewData.absKey;
    }

    const targetElClass = `hbViewContainer--${this.newViewUid()}`;
    args.targetEl.classList.add(targetElClass);
    hbClient.socket.send({
      channel: 'viewRequest',
      data: {
        absKey: args.absKey,
        targetEl: `.${targetElClass}`,
      },
    });
  }, // end viewRequest

  populateView(absKey) {
    hbClient.socket.send({
      channel: 'populateView',
      data: {
        absKey,
      },
    });
  }, // end populateView

  curViewUid: 0,
  newViewUid() {
    this.curViewUid++;
    return this.curViewUid;
  },

}; // end hbClientSocketViewRequests

export default hbClientSocketViewRequests;
