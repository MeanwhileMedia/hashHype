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
            wordsFor2dGram: props.wordsFor2dGram || [], // a record of which words (previously pointed above 0) are valid words to be used in forming 2dGrams for this comment. See topCommentStats.extractNew2dGramsFromTopComment
            points: {
                '1Hr': {}, // {foo_bar: 342, other_word: etc...}
                '12Hr': {},
                '24Hr': {},
            },
            totalPoints: { // summed totals from the above points attr.
                '1Hr': 0,
                '12Hr': 0,
                '24Hr': 0,
            },
            topSymbols: {
                '1Hr': [], // array of symbol redis keys which topCommentStats has deemed to be the most important symbols on this comment.
                '12Hr': [],
                '24Hr': [],
            },
            topSymbolHigh: {
                '1Hr': {}, // {key: 'symbol:stock:GME', points: 536}
                '12Hr': {},
                '24Hr': {},
            },
            topSymbolLow: {
                '1Hr': {}, // {key: 'symbol:stock:TSLA', points: 42}
                '12Hr': {},
                '24Hr': {},
            },
            topSymbolsTotalPoints: {
                '1Hr': 0, // The sum of topSymbolHigh.points and topSymbolLow.points earned for this comment.
                '12Hr': 0,
                '24Hr': 0,
            },
        }

        return commentObj;
    },

    minimizeForDb: function(commentObj){
        // comments tend to be relatively large redis objects. Run this function on a commentObject before db.set and all props that
        // arent required for persistence will be deleted.
        // RETURNS A SHALLOW COPY! This function will not alter the original commentObj arg. First it clones, then returns the clone object.
        // The returned object should be saved immediately and not used for other purposes.
        const commentClone = { ...commentObj }; // this is a shallow copy so nested objects should not be altered within this function.

        delete commentClone.pendingSymbols; // a temporary prop for extractWOrdsFromComments.preserveSymbolsInCommentBody
        delete commentClone.symbols; // a temporary prop for topCommentStats. is an array of full symbol objects used for rendering into UI.
        delete commentClone.topSymbolsSorted; // a temporary prop for topCommentStats. is an array of full symbol objects used for rendering into UI.

        return commentClone;
    }

}; // end commentObjModel


export default commentObjModel;
