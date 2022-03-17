import { v4 as uuidv4 } from 'uuid';

// For any process which must create comment objects to be stored to redis
const commentObjModel = {

    createNewCommentObject: function(props = {}) {
        props.id = uuidv4();
        return commentObjModel.ensureCommentObjectDefaults(props);
    },

    ensureCommentObjectDefaults: function(props = {}) {
        if (!props.id) {
            console.warn(`Comment is missing an id! Can't ensureCommentObjectDefaults. Please inspect:`, props);
        }
        const commentObj = {
            class: 'comment',
            id: props.id || uuidv4(),
            source: props.source || null, // 'reddit_wsb', 'twitter_sampleStream', etc
            body: props.body || null, // comment.body is the renderable string. The closest (sanitized) representation of what was orignially posted by commenter.
            originalBody: props.originalBody || null, // comment.body gets maniplulated to format symbols/urls/etc. We keep a copy of the untouched originalBody too.
            normalizedBody: props.normalizedBody || null, // this is comment.body with contractions expanded + more. See extractWordsFromComments.sanitizeAndNormalizeCommentBody
            stemmedBody: props.stemmedBody || null, // the comment.body passed through natural.PorterStemmer. Lets us know how our code understood the comment.body
            author: props.author || {name: null},
            createdUtc: props.createdUtc || Date.now(), // when the comment was posted (ms). When available, this prop is read from source API. Therefore, this tstamp IS NOT used in our comment pointing algo (we use foundAt - a tstamp hashHype controls)
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
            symbols: props.symbols || [], // array of symbol objects. Not saved to DB as part of a comment:id object (see minimizeForDb), but will remain on comments that become part of a parent stat object.
            rank: props.rank || null, // int - if this comment happens to be part of stats:topComments, this rank will be set accordingly.
            rankAdjust: props.rankAdjust || null, // int - if this comment has rank, topCommentStats.js will also attempt to apply an "adjusted rank" based on historical data computed by topTrendStats.js. Note that this will not always be defined (even if rank is defined). More than one comment within stats:topComments may share the same rankAdjust.
            wordsFor2dGram: props.wordsFor2dGram || [], // ['GME', 'foo_!!_bar', etc.] - this is a record of all words which have already been accounted for when forming new 2dGrams. Used by topCommentStats extractNew2dGramsFromTopComment
            pointsRecords: props.pointsRecords || {
                '1Hr': {}, // {foo_bar: [tstamp1, tstamp20], other_word: etc...} this prop is used in topCommentStats during calcTotalPointsForPendingTopComments
                '12Hr': {},
                '24Hr': {},
            },
            // deleted: bool // this flag is sometimes used locally but is never saved to redis (it's set to true when a live copy must be blocked from any future saves)
        }

        return commentObj;
    },

    getPointed2dGramCount: function(commentObj, timeBucket = '1Hr') {
        let pointed2dGramCount = 0;
        for (const [thisWordStr, thisWordRef] of Object.entries(commentObj.words)) {
            if (thisWordRef.type === '2dGram' && commentObj.points[timeBucket][thisWordRef.word]) {
                ++pointed2dGramCount;
            }
        };
        return pointed2dGramCount;
    },

    minimizeForDb: function(commentObj, inPlace = false){
        // comments tend to be relatively large redis objects. Run this function on a commentObject before db.set and all props that
        // arent required for persistence will be deleted.
        // RETURNS A SHALLOW COPY! (unless inPlace == true) This function will not alter the original commentObj arg. First it clones, then returns the clone object.
        // The returned object should be saved immediately and not used for other purposes.
        let commentClone;
        if (inPlace) {
            commentClone = commentObj;
        } else {
            commentClone = { ...commentObj }; // this is a shallow copy so nested objects should not be altered within this function.
        }
        delete commentClone.pendingSymbols; // a temporary prop for extractWOrdsFromComments.preserveSymbolsInCommentBody
        delete commentClone.symbols; // a temporary prop for topCommentStats. is an array of full symbol objects used for rendering into UI.
        delete commentClone.wordAssocs;

        return commentClone;
    },

    minimizeForClient: function(commentObj, inPlace = false){
        // comments tend to be relatively large objects. Run this function on a commentObject before setting to topCommentStats, or any other object that gets sent to browser/client via uiServer.js
        // RETURNS A SHALLOW COPY! (unless inPlace == true) This function will not alter the original commentObj arg. First it clones, then returns the clone object.
        let commentClone;
        if (inPlace) {
            commentClone = commentObj;
        } else {
            commentClone = { ...commentObj }; // this is a shallow copy so nested objects should not be altered within this function.
        }
        delete commentClone.pendingSymbols; // a temporary prop for extractWOrdsFromComments.preserveSymbolsInCommentBody
        delete commentClone.pointsRecords; // a prop for topCommentStats pointing logic. Persisted to redis as it's own object at comment:id:pointsRecords
        delete commentClone.wordsFor2dGram; // a record of all words which have already been accounted for when forming new 2dGrams. Used by topCommentStats extractNew2dGramsFromTopComment
        delete commentClone.wordAssocs;

        return commentClone;
    },

    saveCommentObject: function(commentObj, redisClient, cback) {
        const minimizedCommentObj = commentObjModel.minimizeForDb(commentObj);
        redisClient.set(`comment:${commentObj.id}`, minimizedCommentObj, () => {
            if (cback) cback(commentObj);
        });
    },

    deleteCommentObject: function(commentObj, redisClient, cback) {
        redisClient.del(`comment:${commentObj.id}`, () => {
            if (cback) cback();
        });
    }

}; // end commentObjModel


export default commentObjModel;
