import { v4 as uuidv4 } from 'uuid';

// For any process which must create comment objects to be stored to redis
const commentObjModel = {

    createCommentObject: function(props = {}) {
        const commentObj = {
            class: 'comment',
            id: uuidv4(),
            body: props.body || null, // comment.body is the renderable string. The closest (sanitized) representation of what was orignially posted by commenter.
            originalBody: props.originalBody || null, // comment.body gets maniplulated to format symbols/urls/etc. We keep a copy of the untouched originalBody too.
            normalizedBody: props.normalizedBody || null, // this is comment.body with contractions expanded + more. See extractWordsFromComments.sanitizeAndNormalizeCommentBody
            stemmedBody: props.stemmedBody || null, // the comment.body passed through natural.PorterStemmer. Lets us know how our code understood the comment.body
            author: props.author || {name: null},
            createdUtc: props.createdUtc || Date.now(), // when the comment was posted (ms)
            foundAt: props.foundAt || Date.now(), // when the comment registered to hashHype
            words: props.words || {}, // object with wordRef objects for vals { 'word_!!_1': wordRef1, 'other_!!_word_!!_GME': wordRef2, etc}
            wordAssocs: props.wordAssocs || {}, // {':happy_face:': {assoc: 'http://imgUrl.jpg', type: 'img'}, etc..} - When parsing raw comments, this offers a way to preserve a word association within comment.body to an image, url, etc greater context. When the raw comment is later processed in "extractWordsFromComments" - this data should be transferred to the individual word/symbol redis object, and this property can be deleted from comment object.
            points: props.points || {
                '1Hr': {}, // {foo_bar: 342, other_word: etc...}
                '12Hr': {},
                '24Hr': {},
            },
            totalPoints: props.totalPoints || { // summed totals from the above points attr.
                '1Hr': 0,
                '12Hr': 0,
                '24Hr': 0,
            },
            topSymbolHigh: props.topSymbolHigh || {
                '1Hr': null, // string. a symbol redis key
                '12Hr': null,
                '24Hr': null,
            },
            topSymbolLow: props.topSymbolLow || {
                '1Hr': null, // string. a symbol redis key
                '12Hr': null,
                '24Hr': null,
            },
            // deleted: bool // this flag is sometimes used locally but is never saved to redis (it's set to true when a live copy must be blocked from any future saves)
            // see createAuxiliaryDataDefaults for additional properties that will be available to comment objects when required (via restoreAuxiliaryData)
        }

        return commentObj;
    },
    createAuxiliaryDataDefaults: function(commentObj) {
        // Below items are stored in redis separate from the comment object ("auxiliary" data). This function sets defauly values before attempting to recover from redis.
        const auxiliaryDataDefaults = {
            wordsFor2dGram: [], // ['GME', 'foo_!!_bar', etc.] - this is a record of all words which have already been accounted for when forming new 2dGrams. Used by topCommentStats extractNew2dGramsFromTopComment
            pointsRecords: { // Persisted to redis as it's own object at comment:id:pointsRecords
                '1Hr': {}, // {foo_bar: [tstamp1, tstamp20], other_word: etc...} this prop is used in topCommentStats during calcTotalPointsForPendingTopComments
                '12Hr': {},
                '24Hr': {},
            },
        }

        return Object.assign(commentObj, auxiliaryDataDefaults);
    },

    restoreAuxiliaryData: function(commentObj, redisClient, cback) {
        commentObjModel.createAuxiliaryDataDefaults(commentObj);
        commentObjModel.getPointsRecords(commentObj, redisClient, () => {
            commentObjModel.getWordsFor2dGram(commentObj, redisClient, () => {
                if (cback) cback(commentObj);
            });
        });
    },
    saveAuxiliaryData: function(commentObj, redisClient, cback) {
        commentObjModel.savePointsRecords(commentObj, redisClient, () => {
            commentObjModel.saveWordsFor2dGram(commentObj, redisClient, () => {
                if (cback) cback(commentObj);
            });
        });
    },

    getPointsRecords: function(commentObj, redisClient, cback){
        redisClient.get(`comment:${commentObj.id}:pointsRecords`, (commentPointsRecords) => {
            if (commentPointsRecords) commentObj.pointsRecords = commentPointsRecords;
            if (cback) cback(commentObj);
        });
    },
    savePointsRecords: function(commentObj, redisClient, cback){
        if (!commentObj.pointsRecords) {
            // console.warn(`Can't save pointsRecords because it does not exist on live comment:${commentObj.id}`);
            if (cback) cback(commentObj);
            return;
        }
        if (Object.values(commentObj.pointsRecords).map(thisTimeBucket => Object.keys(thisTimeBucket)).flat().length === 0) {
            // console.warn(`Won't save pointsRecords because it is empty on live comment:${commentObj.id}`);
            if (cback) cback(commentObj);
            return;
        }
        redisClient.set(`comment:${commentObj.id}:pointsRecords`, commentObj.pointsRecords, () => {
            if (cback) cback(commentObj);
        });
    },

    getWordsFor2dGram: function(commentObj, redisClient, cback){
        redisClient.get(`comment:${commentObj.id}:wordsFor2dGram`, (commentWordsFor2dGram) => {
            if (commentWordsFor2dGram) commentObj.wordsFor2dGram = commentWordsFor2dGram;
            if (cback) cback(commentObj);
        });
    },
    saveWordsFor2dGram: function(commentObj, redisClient, cback){
        if (!commentObj.wordsFor2dGram) {
            // console.warn(`Can't save wordsFor2dGram because it does not exist on live comment:${commentObj.id}`);
            if (cback) cback(commentObj);
            return;
        }
        if (commentObj.wordsFor2dGram.length === 0) {
            // console.warn(`Won't save wordsFor2dGram because it is empty on live comment:${commentObj.id}`);
            if (cback) cback(commentObj);
            return;
        }
        redisClient.set(`comment:${commentObj.id}:wordsFor2dGram`, commentObj.wordsFor2dGram, () => {
            if (cback) cback(commentObj);
        });
    },

    minimizeForDb: function(commentObj){
        // comments tend to be relatively large redis objects. Run this function on a commentObject before db.set and all props that
        // arent required for persistence will be deleted.
        // RETURNS A SHALLOW COPY! This function will not alter the original commentObj arg. First it clones, then returns the clone object.
        // The returned object should be saved immediately and not used for other purposes.
        const commentClone = { ...commentObj }; // this is a shallow copy so nested objects should not be altered within this function.

        delete commentClone.pendingSymbols; // a temporary prop for extractWOrdsFromComments.preserveSymbolsInCommentBody
        delete commentClone.symbols; // a temporary prop for topCommentStats. is an array of full symbol objects used for rendering into UI.
        delete commentClone.pointsRecords; // aux data. a temp prop for topCommentStats pointing logic. Persisted to redis as it's own object at comment:id:pointsRecords
        delete commentClone.wordsFor2dGram; // aux data. a temp record of all words which have already been accounted for when forming new 2dGrams. Used by topCommentStats extractNew2dGramsFromTopComment
        delete commentClone.wordAssocs;

        return commentClone;
    },

    saveCommentObject: function(commentObj, redisClient, cback) {
        commentObjModel.saveAuxiliaryData(commentObj, redisClient, () => {
            const minimizedCommentObj = commentObjModel.minimizeForDb(commentObj);
            redisClient.set(`comment:${commentObj.id}`, minimizedCommentObj, () => {
                if (cback) cback(commentObj);
            });
        });
    },

}; // end commentObjModel


export default commentObjModel;
