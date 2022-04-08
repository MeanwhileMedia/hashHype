import stopWords from '../stopWords.js';

// For any process which must create wordRef objects to be stored to redis (wordRefs are usually part of comment objects. Never their own redis object entity.)
const wordObjModel = {

    // Every 10 minutes, all wordToCommentsIndex and word:foo_bar:foundAt redis objects are cleaned up. Comments and foundAt timestamps
    // which are older than this.trackWordsFor will be removed from redis.
    trackWordsFor: 86400000, // ms (24hrs) How long should we keep tstamps stored to word:foo_bar:foundAt lists
    wordUseInterval: 3600000*2, // ms (2hr) How long until a single user can recomment the same word and have it earn points. See addFoundAtTstampForWord.
    // we are using 2hrs for wordUseInterval. If we used 1hr (our realtime timebucket), userA could comment the same word 10 minutes apart, and earn on both uses for 10 minutes (1hr after the first use, before the later use exits our 1hr timebucket)

    wordCountLastInterval: 0, // For logging our new word volume.
    wordCountIntervalLength: 5000, // ms, how long should we count comments before we log the sum and restart. Set it to same as reddit fetchLoopIntervalTime for easy volume comparison.
    wordCountInterval: null,

    cleanupWordToCommentsIndexesInterval: null,
    cleanupWordToCommentsIndexesIntervalTime: 6000*10,
    cleanupWordToCommentsIndexes: [], // array of redis sorted set keys

    cleanupWordToUsersIndexesInterval: null,
    cleanupWordToUsersIndexesIntervalTime: 7000*10, // staggered for performance
    cleanupWordToUsersIndexes: [], // array of redis sorted set keys

    cleanupWordFoundAtListsInterval: null,
    cleanupWordFoundAtListsIntervalTime: 8000*10,
    cleanupWordFoundAtLists: [], // array of redis list keys

    createWordRefObject: function(props = {}) { // Must provide value, and type
        // returns an initial state for a new word ref. Word ref objects are stored inside comments and contain word data that pertains to that specific comment.
        // A word ref will have the info needed to lookup a full word object when necc.

        let distance = null;
        if (typeof props.distance === 'number') distance = props.distance;
        let pointVal = null;
        if (typeof props.pointVal === 'number') pointVal = props.pointVal;
        const wordRefObj = {
            class: 'wordRef',
            word: props.word, // Stringified version (foo_!!_bar) of what would be the word.value prop on the actual word object. Can be used to form a redis key for word (word:foo_bar)
            type: props.type, // 'word', 'bigram', 'trigram', '2dGram'
            isSymbolAlias: props.isSymbolAlias || false, // if this single word matched a symbolAlias during symbol extraction, it should be marked as such so it doesn't get double pointed (we add another wordRef for the actual symbol.symbol)
            rawWords: props.rawWords || [], // when rawWords is stored on a wordRef - it is an array of ONLY the unstemmed word sequence strings (space delimeted) which are found in THIS comment.
            hasSymbols: props.hasSymbols || [], // array of symbol object keys ['symbol:stock:gme', etc]
            index: props.index || [], // array of integer indexes which identify this word (props.word) location(s) within the comment.stemmedBody - used for generating 2dGrams
            rawIndex: props.rawIndex || [], // array of integer indexes which identify this words (props.rawWords) location(s) within the comment.body - used for pointing viz
            distance: distance, // a summed measure of how far apart each word is within this multi word sequence within comment.stemmedBody (2dGrams only, null otherwise)
            pointVal: pointVal, // the result from topCommentStats.getWordPointCount. Stored/cached on the wordRef object.
        };

        return wordRefObj;
    },

    registerWordOccurance: function(wordRef, comment, redisClient, cback) {
        const self = wordObjModel;
        // This is the function that any process should call when it has extracted a new word (rather than manually calling addFoundAtTstampForWord themselves). Consistency in order of operations is imperative with this logic.
        // Add a foundAt tstamp for this word and save this comment to it's WordToCommentsIndex (creating one if it does not yet exist)
        // registerWordToCommentsIndex should be done before addFoundAtTstampForWord because other processes (topCommentStats) listen for keyspace changes to word:*:foundAt and the immediately
        // get the wordToCommentsIndex for that word from redis. If the process picked up the foundAt event before this function has time to save the wordToCommentsIndex, then the comment is forgotten in that pointing round.
        self.registerWordToUsersIndex(wordRef, comment, redisClient, (didAddWordToUsersIndex) => {
            if (!didAddWordToUsersIndex) {
                if (cback) cback(false);
            }
            self.registerWordToCommentsIndex(wordRef, comment, redisClient, (didAddWordToCommentsIndex) => {
                if (!didAddWordToUsersIndex) {
                    if (cback) cback(false);
                }
                self.addFoundAtTstampForWord(wordRef, comment, redisClient, (didAddFoundAtTstampForWord) => {
                    if (cback) cback(didAddFoundAtTstampForWord);
                });
            });
        });
    },

    registerWordToCommentsIndex: function(wordRef, comment, redisClient, cback) {
        const self = wordObjModel;
        // A wordToComments index (index:wordToComments:foo_bar) is a redis sorted set of comment ids (order pointed using their foundAt tstamps). Sorted sets let us later fetch ranges based on foundAt time frames.
        // This index is used by topCommentStats when it gets another redis '__keyspace@0__:word:*:foundAt' and needs to determine all of the comments that may be eligible for new points.
        // cback returns true if was added and saved. false otherwise.
        const thisIndexKey = `index:wordToComments:${redisClient.encodeStringForRedisKey(wordRef.word)}`;
        redisClient.zadd(thisIndexKey, [comment.foundAt, comment.id], (itemsAddedCount) => {
            if (itemsAddedCount === 0) {
                // If zadd returns 0, this implies that the item could not be added because it already existed, or the command errored.
                console.warn(`Could not zadd comment:${comment.id} to ${thisIndexKey}. Most likely, that comment id already existed in the sorted set.`);
                if (cback) cback(false);
                return;
            }
            if (cback) cback(true);

            // We must also save a record of all words which have changed wordToCommentsIndex. This process cleans up those objects in intervals. See initCleanupWordToCommentsIndexesInterval
            self.cleanupWordToCommentsIndexes.push(thisIndexKey);
            self.initCleanupWordToCommentsIndexesInterval(redisClient);
        });
    },

    registerWordToUsersIndex: function(wordRef, comment, redisClient, cback) {
        const self = wordObjModel;
        // A wordToUsers index (index:wordToUsers:foo_bar:agentOOjoe) is a redis sorted set of comment ids (order pointed using their foundAt tstamps). Sorted sets let us later fetch ranges based on foundAt time frames.
        // This index is used by topCommentStats to get a list of all comments, by a user, which contained a specific word. A user can only earn points when one of their words is recommented IF they aren't the one who recommented it.
        // cback returns true if was added and saved. false otherwise.
        const thisIndexKey = `index:wordToUsers:${redisClient.encodeStringForRedisKey(wordRef.word)}:${redisClient.encodeStringForRedisKey(comment.author.name)}`;
        redisClient.zadd(thisIndexKey, [comment.foundAt, comment.id], (itemsAddedCount) => {
            if (itemsAddedCount === 0) {
                console.warn(`Could not zadd comment:${comment.id} to ${thisIndexKey}. Most likely, that comment id already existed in the sorted set.`);
                if (cback) cback(false);
                return;
            }
            if (cback) cback(true);

            self.cleanupWordToUsersIndexes.push(thisIndexKey);
            self.initCleanupWordToUsersIndexesInterval(redisClient);
        });
    },

    addFoundAtTstampForWord: function(wordRef, hostComment, redisClient, cback) { // this must be done BEFORE registerWordToCommentsIndex or the foundAt tstamp will be cancelled as dup word by same user.
        const self = wordObjModel;
        // All "foundAt" tstamps are stored to their own redis list at key: word:foo_!!_bar:foundAt

        ////////////
        // We add the foundAt timestamp for this word, but ONLY if this is the first time this user commented it. This is to comply with the following HashHype rule:
        //   - A user can never earn points for a word because they themselves re-commented that word (or users could artificially boost their own comments)
        //   - A user can only earn points ONCE for a word recommented by another user. A user can recomment it more than once (or two users could artificially boost eachothers comment)
        const wordToUsersIndexKey = `index:wordToUsers:${redisClient.encodeStringForRedisKey(wordRef.word)}:${redisClient.encodeStringForRedisKey(hostComment.author.name)}`;
        const now = Date.now();
        redisClient.zrange(wordToUsersIndexKey, now - self.wordUseInterval, now, (commentIdsInRange) => {
            if (commentIdsInRange && commentIdsInRange.length > 1) {
                // Remember that addFoundAtTstampForWord is run AFTER registerWordToUsersIndex (see registerWordOccurance). So the single commentIdsInRange we just found is in
                // fact the same occurance that we are about to save a foundAt timestamp for (NOT a dup word use by this user).
                // console.warn(`Will not store a foundAt tstamp for word:${wordRef.word} because this user (${hostComment.author.name}) already used it within the last ${self.wordUseInterval/3600000}hrs.`)
                if (cback) cback(false);
                return;
            }

            const foundAtKey = self.getWordFoundAtKey(wordRef, redisClient);
            redisClient.zadd(foundAtKey, [hostComment.foundAt, hostComment.foundAt], (itemsAddedCount) => { // value and score are the same (tstamp) in the case of word:foundAt sorted sets
                if (itemsAddedCount === 0) {
                    console.warn(`Could not zadd tstamp ${hostComment.foundAt} to ${foundAtKey} for comment:${hostComment.id}. Most likely, that tstamp already existed in the sorted set.`);
                    if (cback) cback(false);
                    return;
                }
                if (cback) cback(true);
                ++self.wordCountLastInterval;

                self.cleanupWordFoundAtLists.push(foundAtKey);
                self.initCleanupWordFoundAtListsInterval(redisClient);
            });
        });

        if (self.wordCountInterval) return;
        self.wordCountInterval = setInterval(() => {
            console.log(`Stored ${self.wordCountLastInterval} word foundAt timestamps in the last ${self.wordCountIntervalLength/1000} seconds.`);
            self.wordCountLastInterval = 0;
        }, self.wordCountIntervalLength);
    },

    getWordFoundAtKey: function(wordRef, redisClient) {
        const wordEncodedForKey = redisClient.encodeStringForRedisKey(wordRef.word);
        let foundAtKey = `word:${wordRef.type}:${wordEncodedForKey}:foundAt`;
        let isSymbolType;
        if (wordRef.type === 'word' && wordRef.hasSymbols[0]) { // remember that the only time we store single word sequences (type == word) is when they are a symbol
            isSymbolType = wordRef.hasSymbols[0].split(':')[1];
        }
        if (isSymbolType) {
            foundAtKey = `word:symbol:${isSymbolType}:${wordEncodedForKey}:foundAt`;
        }
        return foundAtKey;
    },

    initCleanupWordToCommentsIndexesInterval: function(redisClient) {
        const self = wordObjModel;
        if (self.cleanupWordToCommentsIndexesInterval) return;
        self.cleanupWordToCommentsIndexesInterval = setInterval(() => {
            const cleanupWordToCommentsIndexesClone = [...new Set(self.cleanupWordToCommentsIndexes)]; // remove dups
            self.cleanupWordToCommentsIndexes = []; // reset
            const commentMaxAge = Date.now() - self.trackWordsFor;
            self.execCleanupRedisSortedSet(cleanupWordToCommentsIndexesClone, commentMaxAge, redisClient);
        }, self.cleanupWordToCommentsIndexesIntervalTime);
    },

    initCleanupWordToUsersIndexesInterval: function(redisClient) {
        const self = wordObjModel;
        if (self.cleanupWordToUsersIndexesInterval) return;
        self.cleanupWordToUsersIndexesInterval = setInterval(() => {
            const cleanupWordToUsersIndexesClone = [...new Set(self.cleanupWordToUsersIndexes)]; // remove dups
            self.cleanupWordToUsersIndexes = []; // reset
            const commentMaxAge = Date.now() - self.trackWordsFor;
            self.execCleanupRedisSortedSet(cleanupWordToUsersIndexesClone, commentMaxAge, redisClient);
        }, self.cleanupWordToUsersIndexesIntervalTime);
    },

    initCleanupWordFoundAtListsInterval: function(redisClient) {
        const self = wordObjModel;
        if (self.cleanupWordFoundAtListsInterval) return;
        self.cleanupWordFoundAtListsInterval = setInterval(() => {
            const cleanupWordFoundAtListsClone = [...new Set(self.cleanupWordFoundAtLists)]; // remove dups
            self.cleanupWordFoundAtLists = []; // reset
            const wordMaxAge = Date.now() - self.trackWordsFor;
            self.execCleanupRedisSortedSet(cleanupWordFoundAtListsClone, wordMaxAge, redisClient);
        }, self.cleanupWordFoundAtListsIntervalTime);
    },

    execCleanupRedisSortedSet: function(sortedSetsKeys, maxAge, redisClient) {
        const self = wordObjModel;
        // console.log(`execCleanupRedisSortedSet: Redis word records will now be cleaned up for ${sortedSetsKeys.length} words. They will be trimmed of all items older than ${(Date.now()-maxAge)/3600000}hrs...`);
        sortedSetsKeys.forEach((thisSortedSetKey) => {
            // 1. Clean up the wordToCommentsIndex sorted set first
            redisClient.zremrangebyscore(thisSortedSetKey, 0, maxAge, (itemsRemovedCount) => {
                if (itemsRemovedCount === 0) return;
                // console.warn(`Removed ${itemsRemovedCount} items from redis sorted list: ${thisSortedSetKey}`);
            });
        });
    },

    getWordPointCount: function(wordRef, comment) { // alters wordRef in place
        const self = wordObjModel;
        let points = 0;

        if (!wordRef) {
            console.warn(`wordRef was undefined during call to getWordPointCount. Host comment:`, comment);
            return points;
        }

        if (typeof wordRef.pointVal === 'number') {
            return wordRef.pointVal; // we cache this calculation on the wordRef objects when possible
        }

        if (wordRef.isSymbolAlias) {
            wordRef.pointVal = points;
            return points; // if this isSymbolAlias then there will be another wordRef on this comment holding the actual symbol.symbol in wordRef.word. That wordRef should earn points, not this one.
        }

        let ignoreTokenCount = 0;

        if (wordRef.type === 'word'){ // aka symbol. we ONLY store word:word objects when they matched a symbol in extractWOrdsFromComments process
            points = 5;
            if (wordRef.hasSymbols[0]) { // not all word symbol types get the same points
                if (wordRef.hasSymbols[0].indexOf(':stock:') !== -1) points = 10;
            }
        }
        if (wordRef.type === 'bigram') {
            const theseTokens = wordRef.word.split('_!!_');
            theseTokens.forEach((thisToken) => {
                if (stopWords.ignore.indexOf(thisToken) !== -1) ++ignoreTokenCount;
            });
            points = 1 - ignoreTokenCount;
        }
        if (wordRef.type === 'trigram') {
            const theseTokens = wordRef.word.split('_!!_');
            theseTokens.forEach((thisToken) => {
                if (stopWords.ignore.indexOf(thisToken) !== -1) ++ignoreTokenCount;
            });
            points = 2 - ignoreTokenCount;
        }
        if (wordRef.type === '2dGram') {
            const theseTokens = wordRef.word.split('_!!_')
            const seqCount = theseTokens.length;

            // For 2dGrams, we handle ignoreTokenCount differently. We count the chars in each of our ignore tokens, and add them to our distance penalizer.
            let distance = wordRef.distance;
            theseTokens.forEach((thisToken) => {
                if (stopWords.ignore.indexOf(thisToken) !== -1) distance = distance + thisToken.length;
            });
            // The avg distance measurement penalizes the point count. The higher the distance, the less meaningful this 2dGram.
            points = (20 * seqCount) - distance;
        }

        const wordPointVal = Math.max(0, Math.floor(points));
        wordRef.pointVal = wordPointVal; // update the wordRef so this point tally math is cached on the comment object
        return wordPointVal;
    } //end getWordPointCount

}; // end wordObjModel

export default wordObjModel;
