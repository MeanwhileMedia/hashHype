// For any process which must create word objects to be stored to redis
const wordObjModel = {

    // Every 10 minutes, all wordToCommentsIndex and word:foo_bar:foundAt redis objects are cleaned up. Comments and foundAt timestamps
    // which are older than this.trackWordsFor will be removed from redis.
    trackWordsFor: 86400000, // ms (24hrs) How long should we keep tstamps stored to word:foo_bar:foundAt lists
    cleanupWordRecordsInterval: null,
    cleanupWordRecordsIntervalTime: 6000*10,
    cleanupWordRecords: [], // array of word strings

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
        const wordRefObj = {
            class: 'wordRef',
            word: props.word, // Stringified version (foo_!!_bar) of what would be the word.value prop on the actual word object. Can be used to form a redis key for word (word:foo_bar)
            type: props.type, // 'word', 'bigram', 'trigram', '2dGram'
            rawWords: props.rawWords || [], // when rawWords is stored on a wordRef - it is an array of ONLY the unstemmed word sequence strings (space delimeted) which are found in THIS comment.
            hasSymbols: props.hasSymbols || [], // array of symbol object keys ['symbol:stock:gme', etc]
            index: props.index || [], // array of integer indexes which identify this words location(s) within the comment.body
            distance: props.distance || null // a measure of how far apart each word is within this multi word sequence within this comment (2dGrams only, null otherwise)
        };

        return wordRefObj;
    },

    generateWordObjectKey: function(wordObjOrString) { // can accept wordRef.word (this_!!_is_!!_word) OR a word object, and will conver word.value (arr) into an absKey
        let wordObjectKey = '';

        if (typeof wordObjOrString === 'string') {
            wordObjectKey = `word:${wordObjOrString}`;
            return wordObjectKey;
        }

        if (wordObjOrString.type === '2dGram') {
            wordObjOrString.value.forEach((thisWordSeq) => {
                if (wordObjectKey !== '') wordObjectKey = wordObjectKey + '__!!!!__';
                wordObjectKey = wordObjectKey + thisWordSeq.join('_!!_');
            });
            wordObjectKey = `word:${wordObjectKey}`;
        } else {
            wordObjectKey = `word:${wordObjOrString.value.join('_!!_')}`; // _!!_ is the hashHype word delimeter
        }
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
        // a comment index (index:wordToComments:foo_bar) is a redis sorted set of comment ids (pointed using their
        // createdUtc tstamps). Sorted sets let us later fetch ranges based on createdUtc time frames.
        // cback returns true if was added and saved. false otherwise.
        const thisIndexKey = `index:wordToComments:${wordString}`;
        redisClient.zadd(thisIndexKey, [comment.createdUtc, comment.id], (itemsAddedCount) => {
            if (itemsAddedCount === 0) {
                // If zadd returns 0, this implies that the item could not be added because it already existed, or the command errored.
                console.warn(`Could not zadd comment:${comment.id} to ${thisIndexKey}. Most likely, that comment id already existed in the sorted set.`);
                if (cback) cback(false); // return false and no word:foundAt tstamp will be registered either.
                return;
            }
            if (cback) cback(true);

            // We must also save a record of all words which have changed wordToCommentsIndex. This process cleans up those objects in intervals. See initCleanupWordRecordsInterval
            self.cleanupWordRecords.push(wordString);
            self.initCleanupWordRecordsInterval(redisClient);
        });
    },

    addFoundAtTstampForWord: function(redisWordKey, hostComment, redisClient, cback) {
        // All "foundAt" tstamps are stored to their own redis list at key: word:foo_!!_bar:foundAt
        const foundAtListKey = `${redisWordKey}:foundAt`; // rpush auto creates list if it does not already exist
        redisClient.rpush(foundAtListKey, [hostComment.foundAt], (listLength) => {
            if (cback) cback();
        });
    },

    initCleanupWordRecordsInterval: function(redisClient) {
        const self = wordObjModel;
        if (self.cleanupWordRecordsInterval) return;
        self.cleanupWordRecordsInterval = setInterval(() => {
            self.execWordRecordsCleanup(redisClient);
        }, self.cleanupWordRecordsIntervalTime);
    },

    execWordRecordsCleanup: function(redisClient) {
        const self = wordObjModel;
        // const cleanupWordRecordsClone = [...self.cleanupWordRecords]; // jww stoppping remove dups
        const cleanupWordRecordsClone = [...new Set(self.cleanupWordRecords)]; // remove dups
        self.cleanupWordRecords = [];
        console.log(`Redis word records will now be cleaned up for ${cleanupWordRecordsClone.length} words. They will be trimmed of all items older than ${self.trackWordsFor/3600000}hrs...`);
        cleanupWordRecordsClone.forEach((thisWordStr) => {
            // 1. Clean up the wordToCommentsIndex sorted set first
            const thisWordToCommentsIndexKey = `index:wordToComments:${thisWordStr}`;
            const now = Date.now();
            const maxAge = now - self.trackWordsFor;
            redisClient.zremrangebyscore(thisWordToCommentsIndexKey, 0, maxAge, (itemsRemovedCount) => {
                if (itemsRemovedCount === 0) return;
                console.log(`Removed ${itemsRemovedCount} items from redis sorted list: ${thisWordToCommentsIndexKey}`);
            });

            // 2. Now clean up the word:foundAt list
            const foundAtListKey = `word:${thisWordStr}:foundAt`;
            redisClient.lrange(foundAtListKey, 0, -1, (allFoundAtTstamps) => {
                let trimStart = 0; // the index in list at which tstamps stop being too old. These lists are sorted ascending.
                allFoundAtTstamps.some((thisTstamp, thisTstampIndex) => {
                    const isOldTstamp = Date.now() - thisTstamp > self.trackWordsFor;
                    if (!isOldTstamp) return true; // break from loop. We have looped through all the old tstamps.
                    trimStart = thisTstampIndex;
                });
                if (trimStart === 0) return;
                redisClient.ltrim(foundAtListKey, trimStart, -1);
                console.log(`Trimmed ${trimStart} items from redis list: ${foundAtListKey}`);
            });
        });
    }

}; // end wordObjModel

export default wordObjModel;
