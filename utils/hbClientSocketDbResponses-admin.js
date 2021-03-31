import RedisClient from '../utils/redisClient.js';

// This file includes all the socket requests to set/alter redis data based on the trend training UI
class HbClientSocketDbResponses_admin {
    constructor(opts) {
        this.redisDbClient = opts.redisDbClient;
        this.redisSubClient = opts.redisSubClient;
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
        self.redisDbClient.set(self.trainingNotRelevantKey, JSON.stringify(self.trainingNotRelevant));
        // , (err) => {
        //     if (err) {
        //         console.log(`Could not set ${self.trainingNotRelevantKey}`, err);
        //         return;
        //     }
        //     if (!commentId) return;
        //     self.deleteComment({data: {commentId: commentId}});
        // });
    }

    markWordNotRelevant(message, socket) {
        const self = this;
        const word = message.data.word;
        const commentId = message.data.commentId; // optional (so the comment which caused this word to become not relevant will have this word deducted from it)
        if (!word) return;

        // First, add this new entry to our global traingin:notRelevant object
        const exists = self.trainingNotRelevant.words.find(thisWord => thisWord.word === word);
        if (!exists) {
            self.trainingNotRelevant.words.push({
                word: word,
                tstamp: Date.now()
            });
        }

        // also delete this word object from redis
        const wordKey = `word:${word}`;
        self.redisDbClient.del(wordKey);

        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: wordKey,
            tstamp: Date.now()
        });
        self.redisDbClient.set(self.trainingNotRelevantKey, JSON.stringify(self.trainingNotRelevant));
        // , (err) => {
        //     if (err) {
        //         console.log(`Could not set ${self.trainingNotRelevantKey}`, err);
        //         return;
        //     }
        //     if (!commentId) return;
        //     self.deleteWordFromComment({data: {word: word, commentId: commentId}});
        // });
    }

    deleteWordFromComment(message, socket) {
        const self = this;
        const word = message.data.word;
        const commentId = message.data.commentId;
        const commentKey = `comment:${commentId}`;
        if (!word || !commentId) return;
        this.redisDbClient.get(`comment:${commentId}`, (err, json) => {
            if (err || !json) {
                console.log(`Could not get comment:${commentId}`, err);
                return;
            }
            const comment = JSON.parse(json);

            // First, remove it from the words array
            const wordIndex = comment.words.findIndex((thisWord) => thisWord.word === word);
            if (wordIndex === -1) return;
            comment.words.splice(wordIndex, 1);

            // Second, remove all points which this word may have already earned
            const newPoints = {};
            for (const [pointKey, pointCount] of Object.entries(comment.points)) {
                if ( pointKey.split('__')[0] !== word ) {
                    newPoints[pointKey] = pointCount;
                } else {
                    console.log(`Removing ${pointCount} points earned for word ${word} from comment: ${comment.id}`)
                }
            }
            comment.points = newPoints;

            // Set comment changes and update training object lastAffected
            self.redisDbClient.set(commentKey, JSON.stringify(comment));

            self.trainingNotRelevant.lastAffected = [];
            self.trainingNotRelevant.lastAffected.push({
                key: commentKey,
                tstamp: Date.now()
            });
            self.redisDbClient.set(self.trainingNotRelevantKey, JSON.stringify(self.trainingNotRelevant));
    });
    }

    deleteSymbolFromComment(message, socket) { // nothing in the training UI currently triggers this (symbols have function editors)
        const self = this;
        const symbol = message.data.symbol;
        const commentId = message.data.commentId;
        const commentKey = `comment:${commentId}`;
        if (!symbol || !commentId) return;
        this.redisDbClient.get(`comment:${commentId}`, (err, json) => {
            if (err || !json) {
                console.log(`Could not get comment:${commentId}`, err);
                return;
            }
            const comment = JSON.parse(json);

            //JWW STOPPING POINT -
            // 1. DONE - Build an input in adminTrain for symbols allowing code snippets for custom matching logic (many single charachters within comments
            //    are matching as symbols (cuz stupid wall street assigned single char stock symbols)). This single char or other ambiguous stock symbols could be customized to caps only, or must be prepended by $, etc.
            //    This logic could also allow for looser matching rules (like matching on a company name instead of specifically it's stock symbol)
            // 2. WIP - Build an option into adminTrain to edit symbol data (like the "name" prop which is rendered large in wheel UI - sometimes contains excess info like "Gamestop - Class A" etc).
            //    This feature will also help admins manually add descriptive data to URL symbols (see #3 below)
            //         JWW stopping point - need to use the get function when assigning symbol objects to topComments (so custom get logic is applied to rendered content)
            // 3. Extract URLS from comments as a new type of symbol. Make sure none of the URL chars get extracted as words during tokenization
            // 4. Adjust redis aof settings because it appears to be saving too often - also look into the minifaction feature


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
            for (const [pointsKey, pointsCount] of Object.entries(comment.points)) { // the points object strait from redis looks like: {"foo_bar__1616453254162": 5, etc...}
                const matched = pointsKey.search(new RegExp(`(_|^)(${symbol.symbol})(_)`));
                if (matched !== -1) {
                    pointsRemoved = pointsRemoved + pointsCount;
                    delete comment.points[pointsKey];
                }
            };
            if (pointsRemoved) console.log(`Removed ${pointsRemoved} points from comment:${comment.id} after deleting symbol ${symbol.symbol}`);

            // Set comment changes and update training object lastAffected
            self.redisDbClient.set(commentKey, JSON.stringify(comment));

            self.trainingNotRelevant.lastAffected = [];
            self.trainingNotRelevant.lastAffected.push({
                key: commentKey,
                tstamp: Date.now()
            });
            self.redisDbClient.set(self.trainingNotRelevantKey, JSON.stringify(self.trainingNotRelevant));
        });
    }

    deleteComment(message, socket) {
        const self = this;
        const commentId = message.data.commentId;
        const commentKey = `comment:${commentId}`;
        if (!commentId) return;

        console.log(`deleteComment: ${commentId}`);
        this.redisDbClient.del(commentKey);

        // add this new comment to our global traingin:notRelevant object
        const exists = self.trainingNotRelevant.comments.find(thisComment => thisComment.id === commentId);
        if (exists) {
            console.log(`Comment ${commentId} has already been marked as not relevent. Canceling request.`);
            return;
        }
        self.trainingNotRelevant.comments.push({
            id: commentId,
            tstamp: Date.now()
        });

        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: commentKey,
            tstamp: Date.now()
        });
        self.redisDbClient.set(self.trainingNotRelevantKey, JSON.stringify(self.trainingNotRelevant));
    }

    editSymbolFunction(message, socket) {
        const self = this;
        const opts = message.data;
        if (!opts || !opts.symbol || !opts.functionName || !opts.functionString) return;
        if (opts.functionName !== 'get' && opts.functionName !== 'match') return;
        const symbolRedisKey = `symbol:${opts.symbol.type}:${opts.symbol.symbol}`
        this.redisDbClient.get(symbolRedisKey, (err, json) => {
            if (err || !json) {
                console.log(`Could not get ${symbolRedisKey}`, err);
                return;
            }
            const symbolRedisData = JSON.parse(json);
            // First run it in a try/catch before saving to redis - in case the edited function contains an error.
            try {
                let testFunc;
                if (opts.functionName === 'get') {
                    testFunc = new Function(`const execFunc = (props) => { ${opts.functionString} }; return execFunc.apply(undefined, arguments);`);
                    const alteredProps = testFunc(symbolRedisData);
                    if (typeof alteredProps !== 'object') throw 'Symbol get function must return an object.'
                }
                if (opts.functionName === 'match') {
                    testFunc = new Function(`const execFunc = (props, matchAgainst, isMatch) => { ${opts.functionString} }; return execFunc.apply(undefined, arguments);`);
                    const matchOutcome = testFunc(symbolRedisData, 'bui_gme', true);
                    if (typeof matchOutcome !== 'boolean') throw 'Symbol match function must return a boolean.'
                }
            } catch (error) {
                console.warn(`Edited symbol (${symbolRedisData.symbol}) function ${opts.functionName}() ran with error. Won't save.`, error);
                return;
            }
            // Looks legit, save now.
            console.log(`Saving ${opts.functionName}() function edit on symbol ${opts.symbol.symbol}:`, opts.functionString);
            symbolRedisData[opts.functionName] = opts.functionString;
            self.redisDbClient.set(symbolRedisKey, JSON.stringify(symbolRedisData));
        });
    }

    syncTrainingNotRelevant() {
        // This function gets training:notRelevant from redis (used in discarding comments from flagged users), and adds
        // a keyspace listener so local data is always synced with redis.
        const self = this;
        this.redisDbClient.get(self.trainingNotRelevantKey, (err, json) => {
            if (err || !json) {
                self.trainingNotRelevant = self.createNewNotRelevantTrainingObj();
                console.log(`Could not get ${self.trainingNotRelevantKey}`, err);
                return;
            }
            self.trainingNotRelevant = JSON.parse(json);
        });
        if (self.trainingNotRelevantIsSynced) return;
        self.trainingNotRelevantIsSynced = true;
        self.redisSubClient.on('message', (channel, message) => {
            if (channel === `__keyspace@0__:${self.trainingNotRelevantKey}`) self.syncTrainingNotRelevant();
        });
        self.redisSubClient.subscribe(`__keyspace@0__:${self.trainingNotRelevantKey}`);
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
