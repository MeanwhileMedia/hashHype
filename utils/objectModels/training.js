// For any process which must create one of our training objects to be stored to redis. Note that this "objectModel" is really
// more of a keyspace model. It contains data structures for all objects which fall under the redis "training:*" keyspace.
const trainingObjModels = {

    createTrainingNotRelevantObject: function(props = {}) {
        const notRelevantObj = {
            users: [], // array of objects {username: 'foo', tstamp: tstamp int (when user was marked not relevant via the trend training ui)}
            words: [], // array of objects {word: 'buy_gme', tstamp: tstamp int}
            comments: [], // array of objects {id: comment id, tstamp: tstamp int}
            commentBodies: [], // array of strings of exact comment.body. Comment bodies are sometimes marked as not relevant when they return true from topCommentStates.isDiscardComment
            lastAffected: [] // array of objects {key: full redis key (can be any keyspace/object type), tstamp: tstamp int} // Used by other processes to respond to changes on training:notRelevant object. lastAffected is reset upon every redis set of training:notRelevant
        }

        return notRelevantObj;
    }

}; // end trainingObjModels


export default trainingObjModels;
