// For any process which must create word objects to be stored to redis
const wordObjModel = {

    // Every 10 minutes, all wordToCommentsIndex and word:foo_bar:foundAt redis objects are cleaned up. Comments and foundAt timestamps
    // which are older than this.trackWordsFor will be removed from redis.
    trackWordsFor: 86400000, // ms (24hrs) How long should we keep tstamps stored to word:foo_bar:foundAt lists
    wordUseInterval: 3600000*2, // ms (2hr) How long until a single user can recomment the same word and have it earn points. See addFoundAtTstampForWord.
    // we are using 2hrs for wordUseInterval. If we used 1hr (our realtime timebucket), userA could comment the same word 10 minutes apart, and earn on both uses for 10 minutes (1hr after the first use, before the later use exits our 1hr timebucket)

    cleanupWordToCommentsIndexesInterval: null,
    cleanupWordToCommentsIndexesIntervalTime: 6000*10,
    cleanupWordToCommentsIndexes: [], // array of redis sorted set keys

    cleanupWordToUsersIndexesInterval: null,
    cleanupWordToUsersIndexesIntervalTime: 7000*10, // staggered for performance
    cleanupWordToUsersIndexes: [], // array of redis sorted set keys

    cleanupWordFoundAtListsInterval: null,
    cleanupWordFoundAtListsIntervalTime: 8000*10,
    cleanupWordFoundAtLists: [], // array of redis list keys

    createWordObject: function(props = {}) { // Must provide value, and type
        // returns an initial state for a new word, bigram, trigram object. Word objects are stored as their own redis objects and contain
        // historical data that pertain to that word on a global scale (across all comments which contained this word - for all time - since this word object was created).
        const wordObj = {
            class: 'word',
            value: props.value, // an array of words (word sequence). length 1 for type word, and for 2 bi and 3 tri gram
            type: props.type, // 'word', 'bigram', 'trigram', '2dGram'
            rawWords: props.rawWords || [], // array word sequence strings (space delimeted). These are all of the unstemmed token sequences which have been boiled down to match this word.value (across ALL comments)
            hasSymbols: props.hasSymbols || [], // array of symbol object keys ['symbol:stock:gme', etc]
        };

        return wordObj;
    },

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
            rawWords: props.rawWords || [], // when rawWords is stored on a wordRef - it is an array of ONLY the unstemmed word sequence strings (space delimeted) which are found in THIS comment.
            hasSymbols: props.hasSymbols || [], // array of symbol object keys ['symbol:stock:gme', etc]
            index: props.index || [], // array of integer indexes which identify this word (props.word) location(s) within the comment.stemmedBody - used for generating 2dGrams
            rawIndex: props.rawIndex || [], // array of integer indexes which identify this words (props.rawWords) location(s) within the comment.body - used for pointing viz
            distance: distance, // a summed measure of how far apart each word is within this multi word sequence within comment.stemmedBody (2dGrams only, null otherwise)
            pointVal: pointVal, // the result from topCommentStats.getWordPointCount. Stored/cached on the wordRef object.
        };

        return wordRefObj;
    },

    generateWordObjectKey: function(wordObjOrString) { // can accept wordRef.word (this_!!_is_!!_word) OR a word object, and will conver word.value (arr) into an absKey
        let wordObjectKey = '';

        if (typeof wordObjOrString === 'string') {
            wordObjectKey = `word:${wordObjOrString}`;
            return wordObjectKey;
        }
        wordObjectKey = `word:${wordObjOrString.value.join('_!!_')}`; // _!!_ is the hashHype word delimeter

        return wordObjectKey;
    },

    merge: function(existingWord, newWord) { // updates existingWord in place. returns existingWord
        // There are some properties that will persist from redis, and some that will be updated to the new values.
        if (newWord.rawWords && newWord.rawWords.length) {
            existingWord.rawWords = existingWord.rawWords.concat(newWord.rawWords);
            existingWord.rawWords = [...new Set(existingWord.rawWords)]; // remove dups
        }
        if (newWord.hasSymbols && newWord.hasSymbols.length) {
            existingWord.hasSymbols = existingWord.hasSymbols.concat(newWord.hasSymbols);
            existingWord.hasSymbols = [...new Set(existingWord.hasSymbols)]; // remove dups
        }
        //console.log(`Merged two word objects to be set at key: ${existingWord.value}`);
        return existingWord;
    },

    registerWordToCommentsIndex: function(wordString, comment, redisClient, cback) {
        const self = wordObjModel;
        // A wordToComments index (index:wordToComments:foo_bar) is a redis sorted set of comment ids (order pointed using their createdUtc tstamps). Sorted sets let us later fetch ranges based on createdUtc time frames.
        // This index is used by topCommentStats when it gets another redis '__keyspace@0__:word:*:foundAt' and needs to determine all of the comments that may be eligible for new points.
        // cback returns true if was added and saved. false otherwise.
        const thisIndexKey = `index:wordToComments:${wordString}`;
        self.registerWordToUsersIndex(wordString, comment, redisClient, () => {
            redisClient.zadd(thisIndexKey, [comment.createdUtc, comment.id], (itemsAddedCount) => {
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
        });
    },

    registerWordToUsersIndex: function(wordString, comment, redisClient, cback) {
        const self = wordObjModel;
        // A wordToUsers index (index:wordToUsers:foo_bar:agentOOjoe) is a redis sorted set of comment ids (order pointed using their createdUtc tstamps). Sorted sets let us later fetch ranges based on createdUtc time frames.
        // This index is used by topCommentStats to get a list of all comments, by a user, which contained a specific word. A user can only earn points when one of their words is recommented IF they aren't the one who recommented it.
        // cback returns true if was added and saved. false otherwise.

        const thisIndexKey = `index:wordToUsers:${wordString}:${comment.author.name}`;
        redisClient.zadd(thisIndexKey, [comment.createdUtc, comment.id], (itemsAddedCount) => {
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

    addFoundAtTstampForWord: function(wordString, hostComment, redisClient, cback) { // this must be done BEFORE registerWordToCommentsIndex or the foundAt tstamp will be cancelled as dup word by same user.
        const self = wordObjModel;
        // All "foundAt" tstamps are stored to their own redis list at key: word:foo_!!_bar:foundAt

        ////////////
        // We add the foundAt timestamp for this word, but ONLY if this is the first time this user commented it. This is to comply with the following rules:
        //   - A user can never earn points for a word because they themselves re-commented that word (or users could artificially boost their own comments)
        //   - A user can only earn points ONCE for a word recommented by another user. A user can recomment it more than once (or two users could artificially boost eachothers comment)
        const wordToUsersIndexKey = `index:wordToUsers:${wordString}:${hostComment.author.name}`;
        const now = Date.now();
        redisClient.zrange(wordToUsersIndexKey, now - self.wordUseInterval, now, (commentIdsInRange) => {
            if (commentIdsInRange && commentIdsInRange.length > 0) {
                // console.warn(`Will not store a foundAt tstamp for word:${wordString} because this user (${hostComment.author.name}) already used it within the last ${self.wordUseInterval/3600000}hrs.`)
                if (cback) cback();
                return;
            }
            const foundAtListKey = `word:${wordString}:foundAt`; // rpush auto creates list if it does not already exist
            redisClient.rpush(foundAtListKey, [hostComment.foundAt], (listLength) => {
                if (cback) cback();

                self.cleanupWordFoundAtLists.push(foundAtListKey);
                self.initCleanupWordFoundAtListsInterval(redisClient);
            });
        });
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
            self.execCleanupRedisTstampList(cleanupWordFoundAtListsClone, wordMaxAge, redisClient);
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

    execCleanupRedisTstampList: function(listKeys, maxAge, redisClient) {
        const self = wordObjModel;
        // console.log(`execCleanupRedisTstampList: Redis word records will now be cleaned up for ${listKeys.length} words. They will be trimmed of all items older than ${(Date.now()-maxAge)/3600000}hrs...`);
        listKeys.forEach((thisListKey) => {
            redisClient.lrange(thisListKey, 0, -1, (allFoundAtTstamps) => {
                let trimStart = 0; // the index in list at which tstamps stop being too old. These lists are sorted ascending.
                allFoundAtTstamps.some((thisTstamp, thisTstampIndex) => {
                    const isOldTstamp = thisTstamp < maxAge;
                    if (!isOldTstamp) return true; // break from loop. We have looped through all the old tstamps.
                    trimStart = thisTstampIndex;
                });
                if (trimStart === 0) return;
                redisClient.ltrim(thisListKey, trimStart, -1);
                // console.warn(`Trimmed ${trimStart} items from redis list: ${thisListKey}`);
            });
        });
    }

}; // end wordObjModel

export default wordObjModel;
