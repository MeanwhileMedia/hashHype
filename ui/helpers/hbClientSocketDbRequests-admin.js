
// This file includes all the socket requests to set/alter redis data based on the trend training UI
const hbClientSocketDbRequests_admin = {

  markUserNotRelevant(opts) {
    if (!opts.username) return;
    hbClient.socket.send(JSON.stringify({
      channel: 'markUserNotRelevant',
      data: {
        username: opts.username,
        commentId: opts.commentId || null
      },
    }));
  },

  markWordNotRelevant(opts) {
      if (!opts.word) return;
      hbClient.socket.send(JSON.stringify({
        channel: 'markWordNotRelevant',
        data: {
          word: opts.word,
          commentId: opts.commentId || null
        },
      }));
  },

  deleteWordFromComment(opts) {
      if (!opts.word || !opts.commentId) return;
      hbClient.socket.send(JSON.stringify({
        channel: 'deleteWordFromComment',
        data: {
          word: opts.word,
          commentId: opts.commentId
        },
      }));
  },

  deleteComment(opts) {
      if (!opts.commentId) return;
      hbClient.socket.send(JSON.stringify({
        channel: 'deleteComment',
        data: {
          commentId: opts.commentId
        },
      }));
  },

  editSymbolFunction(opts) {
      if (!opts.symbol || !opts.functionName || !opts.functionString) return;
      hbClient.socket.send(JSON.stringify({
        channel: 'editSymbolFunction',
        data: opts
      }));
  }

}; // end hbClientSocketViewRequests

export default hbClientSocketDbRequests_admin;
