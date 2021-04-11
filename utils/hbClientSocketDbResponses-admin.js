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
        self.redisClient.get(commentIndexKey, (wordToCommentsIndex) => {
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

    deleteSymbolFromComment(message, socket) { // nothing in the training UI currently triggers this (symbols have function editors)
        const self = this;
        const symbol = message.data.symbol;
        const commentId = message.data.commentId;
        const commentKey = `comment:${commentId}`;
        if (!symbol || !commentId) return;
        this.redisClient.get(`comment:${commentId}`, (comment) => {
            if (!comment) return;

            //JWW STOPPING POINT -
            // 1. DONE - Build an input in adminTrain for symbols allowing code snippets for custom matching logic (many single charachters within comments
            //    are matching as symbols (cuz stupid wall street assigned single char stock symbols)). This single char or other ambiguous stock symbols could be customized to caps only, or must be prepended by $, etc.
            //    This logic could also allow for looser matching rules (like matching on a company name instead of specifically it's stock symbol)
            // 2. DONE - Build an option into adminTrain to edit symbol data (like the "name" prop which is rendered large in wheel UI - sometimes contains excess info like "Gamestop - Class A" etc).
            //    This feature will also help admins manually add descriptive data to URL symbols (see #3 below)
            // 3. DONE - Extract URLS from comments as a new type of symbol. Make sure none of the URL chars get extracted as words during tokenization
            // 4. DONE - disabled AOF - Adjust redis aof settings because it appears to be saving too often - also look into the minifaction feature
            // 5. this method "deleteSymbolFromComment" is not used.... should delete?
            // 6. Set expirations on all objects that can be nuked by redis LRU (comments, words) while symbols, stats, training, etc, must never expire.
            //    After that, change the eviction policy to: volatile-lru (currently set to allkeys-lru) OR consider 2 redis dbs - one that can be allkeys-lru (memory store) and one with no evictions (See https://redis.io/topics/lru-cache/#:~:text=The%20maxmemory%20configuration%20directive%20is,configuration%20directive%20using%20the%20redis.&text=When%20the%20specified%20amount%20of,among%20different%20behaviors%2C%20called%20policies.)
            //    WIP - now running 2 redis DBs ('short' and 'long') via the machines config. Next:
            //          - MAYBE - update redisClient.js to overwrite the native node_redis set and get commands. Add logic to automatically set or get to the 'long' db based on a namespace configuration. This way, individual processes don't need to set up the extra "long" client and/or individually maintain the logic for which db to use.
            // 6.5. Set up routine to backup redis DB (rdb) to cloud every 24hrs - AND create snapshots of stats: objects (for long term trend extraction using per-day data)
            // 7. Chance top comment stats to only show 2 wedges for any given symbol
            // 8. only serve admin train FE assets to requests from admin URLs. add functionality to strip JS includes of admin assets during code compilation.
            // 9. Add an "about" icon which includes disclaimer
            // 10. Add google analytics snippet to layout.html

            // Loop through all comment wordRefs and inspect each "hasSymbols" prop. Remove this symbol key whenever found.
            const removeSymbolKey = `symbol:${symbol.type}:${symbol.symbol}`;
            comment.words.forEach((wordRef, wordRefIndex) => {
                const symbolKeyIndex = wordRef.hasSymbols.findIndex((thisSymbolKey) => thisSymbolKey === removeSymbolKey);
                if (symbolKeyIndex) {
                    wordRef.hasSymbols.splice(symbolKeyIndex, 1);
                }
            });
            // We will also remove all points from comment.points which were added for this word. This is not a perfect
            // method for re-tallying points (because we remove ALL points for word - rather than just the symbol multiplier).
            let pointsRemoved = 0;
            const symbolEscapedForRegex = symbol.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\\$&') // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
            const symbolRegex = new RegExp(`(_|^)(${symbolEscapedForRegex})(_)`); // https://regexr.com/5q5nl
            for (const [pointsKey, pointsCount] of Object.entries(comment.points)) { // the points object strait from redis looks like: {"foo_bar__1616453254162": 5, etc...}
                const matched = pointsKey.search(symbolRegex);
                if (matched !== -1) {
                    pointsRemoved = pointsRemoved + pointsCount;
                    delete comment.points[pointsKey];
                }
            };
            if (pointsRemoved) console.log(`Removed ${pointsRemoved} points from comment:${comment.id} after deleting symbol ${symbol.symbol}`);

            // Set comment changes and update training object lastAffected
            self.redisClient.set(commentKey, comment);

            self.trainingNotRelevant.lastAffected = [];
            self.trainingNotRelevant.lastAffected.push({
                key: commentKey,
                tstamp: Date.now()
            });
            self.saveTrainingNotRelevant();
        });
    }

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
            const removeWordEscapedForRegex = removeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\\$&') // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
            const removeWordRegex = new RegExp(`^(${removeWordEscapedForRegex})__`); // https://regexr.com/5q5nl
            const newPoints = {};
            for (const [pointKey, pointCount] of Object.entries(comment.points)) {
                if (pointKey.search(removeWordRegex) !== -1) {
                    newPoints[pointKey] = pointCount;
                }
            }
            comment.points = newPoints;

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
                self.trainingNotRelevant = self.createNewNotRelevantTrainingObj();
                console.log(`Could not get ${self.trainingNotRelevantKey}`);
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

    createNewNotRelevantTrainingObj() {
        return {
            users: [], // array of objects {username: 'foo', tstamp: tstamp int (when user was marked not relevant via the trend training ui)}
            words: [], // array of objects {word: 'buy_gme', tstamp: tstamp int}
            comments: [], // array of objects {id: comment id, tstamp: tstamp int}
            lastAffected: [] // array of objects {key: full redis key (can be any keyspace/object type), tstamp: tstamp int} // Used by other processes to respond to changes on training:notRelevant object. lastAffected is reset upon every redis set of training:notRelevant
        };
    }

}; // end HbClientSocketDbResponses_admin

export default HbClientSocketDbResponses_admin;
