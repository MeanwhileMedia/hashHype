import trainingModels from '../utils/objectModels/training.js';
import symbolModel from '../utils/objectModels/symbol.js';

// This file includes all the socket requests to set/alter redis data based on the trend training UI
class HbClientSocketDbResponses_admin {
    constructor(opts) {
        this.redisClient = opts.redisClient;
        this.trainingNotRelevantKey = 'training:notRelevant';
        this.trainingNotRelevant = null;
        this.syncTrainingNotRelevant(); // sets to this.trainingNotRelevant (from db, or as newly empty if not found in db)
    }

    markUserNotRelevant(message, socket) {
        const self = this;
        const username = message.data.username;
        const commentId = message.data.commentId; // optional (so the comment which caused this user to become not relevant will be deleted)
        if (!username) return;

        const exists = self.trainingNotRelevant.users.find(thisUser => thisUser.username === username);
        if (!exists) {
            self.trainingNotRelevant.users.push({
                username: username,
                tstamp: Date.now()
            });
        }

        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: `user:${username}`,
            tstamp: Date.now()
        });
        self.saveTrainingNotRelevant();
    }

    markWordNotRelevant(message, socket) {
        const self = this;
        const removeWord = message.data.word;
        const commentId = message.data.commentId; // optional (so the comment which caused this word to become not relevant will have this word deducted from it)
        if (!removeWord) return;

        // 1. add this new entry to our global traingin:notRelevant object
        const exists = self.trainingNotRelevant.words.find(thisWord => thisWord.word === removeWord);
        if (!exists) {
            self.trainingNotRelevant.words.push({
                word: removeWord,
                tstamp: Date.now()
            });
        }

        // 2. delete this word object from redis
        const wordKey = `word:${removeWord}`;
        self.redisClient.del(wordKey);

        // 3. add a tstamp for this training change and save to redis
        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: wordKey,
            tstamp: Date.now()
        });

        // 4. get the wordToCommentsIndex and remove any points earned for this word from all host comments
        const commentIndexKey = `index:wordToComments:${removeWord}`;
        self.redisClient.zrange(commentIndexKey, 0, Infinity, (wordToCommentsIndex) => {
            if (!wordToCommentsIndex) return;
            // This is the last time we will use this wordToComments index since the word is being deleted. Delete index too.
            self.redisClient.del(commentIndexKey);
            // Now loop through the comment index and update all comments
            let commentsUpdated = 0;
            wordToCommentsIndex.forEach((commentId) => {
                self.deleteWordFromCommentAndSave(removeWord, commentId, (commentRedisKey) => {
                    commentsUpdated++;
                    // Add this key to our training change record so other processes can respond too
                    self.trainingNotRelevant.lastAffected.push({
                        key: commentRedisKey,
                        tstamp: Date.now()
                    });
                    if (commentsUpdated >= wordToCommentsIndex.length) {
                        // Last, save our new training data to redis
                        self.saveTrainingNotRelevant();
                    }
                })
            });
        });
    }

    deleteWordFromComment(message, socket) {
        const self = this;
        const word = message.data.word;
        const commentId = message.data.commentId;
        const commentKey = `comment:${commentId}`;
        if (!word || !commentId) return;
        self.deleteWordFromCommentAndSave(word, commentId, (commentRedisKey) => {
            self.trainingNotRelevant.lastAffected = [];
            self.trainingNotRelevant.lastAffected.push({
                key: commentKey,
                tstamp: Date.now()
            });
            self.saveTrainingNotRelevant();
        });
    }


    //JWW STOPPING POINT -
    // 1. DONE - Build an input in adminTrain for symbols allowing code snippets for custom matching logic (many single charachters within comments
    //    are matching as symbols (cuz stupid wall street assigned single char stock symbols)). This single char or other ambiguous stock symbols could be customized to caps only, or must be prepended by $, etc.
    //    This logic could also allow for looser matching rules (like matching on a company name instead of specifically it's stock symbol)
    // 2. DONE - Build an option into adminTrain to edit symbol data (like the "name" prop which is rendered large in wheel UI - sometimes contains excess info like "Gamestop - Class A" etc).
    //    This feature will also help admins manually add descriptive data to URL symbols (see #3 below)
    // 3. DONE - Extract URLS from comments as a new type of symbol. Make sure none of the URL chars get extracted as words during tokenization
    // 4. DONE - disabled AOF - Adjust redis aof settings because it appears to be saving too often - also look into the minifaction feature
    // 5. DONE - update redisClient.js to overwrite the native node_redis set and get commands. Add logic to automatically set or get to the 'long' db based on a namespace configuration. This way, individual processes don't need to set up the extra "long" client and/or individually maintain the logic for which db to use.
    //             DONE - this is ready to test... what happens when a words "foundAt" object get's evicted from "short" because of redis's retarded LRU algo. That would drastically change all logic associated with timeBucketWordPointsForComment. Need to add logic to keep these tstamp arrays in long db once they reach a certain length.
    //             DONE - need to design some logic for resetting "New topWordsMinCount: 6". Once it gets high during peak times, it becomes too high during slow times and words are ignored.
    //             DONE - topCommentStats is bypassing comment preserve logic because it currently uses throttled.get. Add dynamic db to batch commands? Decision: Only added to batched.get in a non blocking manner (to preserve performance)
    // 6. Maintenance
    //     DONE - Set up routine to backup redis DB (rdb) to cloud every 24hrs
    //     DONE - rotate and backup logs to cloud
    //     DONE - log db stats in intervals so can track growth
    //     WONT - will use our rdb archives to access historical data. original task: create snapshots of stats: objects (for long term trend extraction using per-day data)
    // 7. DONE - Change top comment stats to only show 2 wedges for any given symbol
    // 7.5 DONE - Duplicate identical comments by same user keep trending. Need a solution. A comment may only receive word/symbol repost points ONCE PER USER (zero times for self)??
    // 8. DONE - Need to extact stock symbols BEFORE stemming (e.g. MVIS is getting stemmed to MVI and never trends as a symbol)
    // 8.5 DONE - only serve admin train FE assets to requests from admin URLs. add functionality to strip JS includes of admin assets during code compilation.
    // 9. DONE - Add improvements to topCommentHigh and topCommentLow logic so that we don't overflow our topComments with symbol duplication
    // 9.5 DONE - Add GNAV including an "about" icon which includes disclaimer
    // 9.6: DONE - See "Clearing LRU items.." - it tramples self. update: increased cache size AND clear percentage. Must test.
    // 9.7: DONE - Add cleanup routine to log and db backup in maintenance process. gdrive ran out of space after just a few days
    // 9.8: DONE - add better logic for "New topWordsMinCount:" - should be set to the lowest 24Hr word count (right now is getting too high)
    // 9.9: DONE - logs need timstamps prepended
    // 9.10: "Could not find redis key in primary DB. Recovered..." appears to be occuring multiple times for same items (like a single comment), either it's fighting against redis LRU or we have an error in recovering from long->short
    // 9.11: DONE - need to take a look at removeCommentFromAll (and removeCommentFromWordToCommentIndexes) where the throttled del/set command may introduce a bug in our preserve/recover logic. We may need a solution for syncing throttled redis commands.
    //          - note that the set commands that were slaughering mem/gc were the wordToCommentIndex objects. It may be time to store these indexes in a different data format (currently JSON strings in redis)
    // 9.12: WONT (focusing on 1hr trend for now) - Need to add an interval to update point counts for all comments in 12/24hr buckets (topCommentStats). The real time updates only apply to the 1hr bucket.
    // 10. Mobile styles
    // 11. Add google analytics snippet to layout.html


    deleteComment(message, socket) {
        const self = this;
        const commentId = message.data.commentId;
        const commentKey = `comment:${commentId}`;
        if (!commentId) return;

        console.log(`deleteComment: ${commentId}`);
        this.redisClient.del(commentKey);

        // add this new comment to our global traingin:notRelevant object
        const exists = self.trainingNotRelevant.comments.find(thisComment => thisComment.id === commentId);
        if (!exists) {
            self.trainingNotRelevant.comments.push({
                id: commentId,
                tstamp: Date.now()
            });
        }

        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: commentKey,
            tstamp: Date.now()
        });
        self.saveTrainingNotRelevant();
    }

    editSymbolFunction(message, socket) {
        const self = this;
        const opts = message.data;
        if (!opts || !opts.symbol || !opts.functionName || !opts.functionString) return;
        if (opts.functionName !== 'get' && opts.functionName !== 'match') return;
        const symbolRedisKey = `symbol:${opts.symbol.type}:${opts.symbol.symbol}`
        this.redisClient.get(symbolRedisKey, (symbolRedisData) => {
            if (!symbolRedisData) {
                console.log(`Could not get ${symbolRedisKey}`);
                return;
            }
            // First run it in a try/catch before saving to redis - in case the edited function contains an error.
            try {
                let testFunc;
                if (opts.functionName === 'get') {
                    symbolRedisData.get = opts.functionString
                    const funcdSymbolData = symbolModel.execGet(symbolRedisData);
                    if (typeof funcdSymbolData !== 'object') throw 'Symbol get function must return an object.'
                }
                if (opts.functionName === 'match') {
                    symbolRedisData.match = opts.functionString
                    const matchOutcome = symbolModel.execMatch(symbolRedisData, 'bui_gme', true);
                    if (typeof matchOutcome !== 'boolean') throw 'Symbol match function must return a boolean.'
                }
            } catch (error) {
                console.warn(`Edited symbol (${symbolRedisData.symbol}) function ${opts.functionName}() ran with error. Won't save.`, error);
                return;
            }
            // Looks legit, save now.
            console.log(`Saving ${opts.functionName}() function edit on symbol ${opts.symbol.symbol}:`, opts.functionString);
            self.redisClient.set(symbolRedisKey, symbolRedisData);
        });
    }

    deleteWordFromCommentAndSave(removeWord, commentId, cback) { // send commentRedisKey to cback
        const self = this;
        // This is not a socket message based function. It's a helper for our other socket methods in this class.
        const commentRedisKey = `comment:${commentId}`;
        self.redisClient.get(commentRedisKey, (comment) => {
            if (!comment) {
                console.log(`Could not get ${commentRedisKey}`);
                return;
            }
            // First remove points
            for (const [pointsTimeBucketKey, pointsTimeBucket] of Object.entries(comment.points)) {
                delete pointsTimeBucket[removeWord];
            }

            // then, remove it from the comment's words array
            const wordIndex = comment.words.findIndex((thisWord) => thisWord.word === removeWord);
            if (wordIndex !== -1) comment.words.splice(wordIndex, 1);

            // save back to redis
            self.redisClient.set(commentRedisKey, comment);
            // all done
            if (cback) cback(commentRedisKey);
        });
    }

    syncTrainingNotRelevant() {
        // This function gets training:notRelevant from redis (used in discarding comments from flagged users), and adds
        // a keyspace listener so local data is always synced with redis.
        const self = this;
        this.redisClient.get(self.trainingNotRelevantKey, (trainingNotRelevant) => {
            if (!trainingNotRelevant) {
                // Since this topCommentStats process writes to the redis 'training:notRelevant' object,
                // it should always be locally defined. Instantiate a blank object now.
                self.trainingNotRelevant = trainingModels.createTrainingNotRelevantObject();
                console.log(`${self.trainingNotRelevantKey} was not yet saved to redis.`);
                return;
            }
            self.trainingNotRelevant = trainingNotRelevant;
        });
        if (self.trainingNotRelevantIsSynced) return;
        self.trainingNotRelevantIsSynced = true;
        self.redisClient.on('message', (channel, message) => {
            if (channel === `__keyspace@0__:${self.trainingNotRelevantKey}`) self.syncTrainingNotRelevant();
        });
        self.redisClient.subscribe(`__keyspace@0__:${self.trainingNotRelevantKey}`);
    }

    saveTrainingNotRelevant() {
        const self = this;
        self.redisClient.set(self.trainingNotRelevantKey, self.trainingNotRelevant);
        // We automatically clear the lastAffected array on self.trainingNotRelevant after a timeout
        // (or else the last affected keys will persist upon process restarts, and they will attempt to respond again)
        if (self.lastAffectedTimeout) clearTimeout(self.lastAffectedTimeout);
        self.lastAffectedTimeout = setTimeout(() => {
            console.log('Automatically clearing trainingNotRelevant.lastAffected after timeout.');
            self.trainingNotRelevant.lastAffected = [];
            self.redisClient.set(self.trainingNotRelevantKey, self.trainingNotRelevant);
            self.lastAffectedTimeout = null;
        }, 60000*10); // We assume 10 minutes will be enough for all processes to finish responding
    }

}; // end HbClientSocketDbResponses_admin

export default HbClientSocketDbResponses_admin;
