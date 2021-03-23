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
        if (exists) return;
        self.trainingNotRelevant.users.push({
            username: username,
            tstamp: Date.now()
        });

        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: `user:${username}`,
            tstamp: Date.now()
        });
        self.redisDbClient.set(self.trainingNotRelevantKey, JSON.stringify(self.trainingNotRelevant), (err) => {
            if (err) {
                console.log(`Could not set ${self.trainingNotRelevantKey}`, err);
                return;
            }
            if (!commentId) return;
            self.deleteComment({data: {commentId: commentId}});
        });
    }

    markWordNotRelevant(message, socket) {
        const self = this;
        const word = message.data.word;
        const commentId = message.data.commentId; // optional (so the comment which caused this word to become not relevant will have this word deducted from it)
        if (!word) return;

        // First, add this new entry to our global traingin:notRelevant object
        const exists = self.trainingNotRelevant.words.find(thisWord => thisWord.word === word);
        if (exists) return;
        self.trainingNotRelevant.words.push({
            word: word,
            tstamp: Date.now()
        });

        // also delete this word object from redis
        let wordType = 'word';
        const wordParts = word.split('_');
        if (wordParts.length === 2) wordType = 'bigram';
        if (wordParts.length === 3) wordType = 'trigram';
        const wordKey = `word:${wordType}:${word}`;
        self.redisDbClient.del(wordKey);

        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: wordKey,
            tstamp: Date.now()
        });
        self.redisDbClient.set(self.trainingNotRelevantKey, JSON.stringify(self.trainingNotRelevant), (err) => {
            if (err) {
                console.log(`Could not set ${self.trainingNotRelevantKey}`, err);
                return;
            }
            if (!commentId) return;
            self.deleteWordFromComment({data: {word: word, commentId: commentId}});
        });
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
            let wordType = 'words';
            const wordParts = word.split('_');
            if (wordParts.length === 2) wordType = 'bigrams';
            if (wordParts.length === 3) wordType = 'trigrams';
            const wordIndex = comment[wordType].findIndex((thisWord) => thisWord.join('_') === word);
            if (wordIndex === -1) return;
            comment[wordType].splice(wordIndex, 1);

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

    deleteSymbolFromComment(message, socket) {
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
            // 1. Build an input in adminTrain for symbols allowing code snippets for custom matching logic (many single charachters within comments
            //    are matching as symbols (cuz stupid wall street assigned single char stock symbols)). This single char or other ambiguous stock symbols could be customized to caps only, or must be prepended by $, etc.
            //    This logic could also allow for looser matching rules (like matching on a company name instead of specifically it's stock symbol)
            // 2. Build an option into adminTrain to edit symbol data (like the "name" prop which is rendered large in wheel UI - sometimes contains excess info like "Gamestop - Class A" etc).
            //    This feature will also help admins manually add descriptive data to URL symbols (see #3 below)
            // 3. Extract URLS from comments as a new type of symbol. Make sure none of the URL chars get extracted as words during tokenization


            // Remove this symbol from comment.symbols
            const symbolIndex = comment.symbols.findIndex((thisSymbol) => thisSymbol.symbol === symbol);
            if (symbolIndex === -1) return;
            comment.symbols.splice(symbolIndex, 1);

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
        if (exists) return;
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
