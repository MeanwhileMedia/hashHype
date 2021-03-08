import RedisClient from '../utils/redisClient.js';

// This file includes all the socket requests to set/alter redis data based on the trend training UI
class HbClientSocketDbResponses_admin {
    constructor(opts) {
        this.redisDbClient = opts.redisDbClient;
        this.notRelevantTrainingKey = 'training:notRelevant';
    }

    markUserNotRelevant(message, socket) {
        const self = this;
        const username = message.data.username;
        if (!username) return;
        let notRelevantTrainingObj = this.createNewNotRelevantTrainingObj();
        this.redisDbClient.get(this.notRelevantTrainingKey, (err, json) => {
            if (err) {
                console.log(`Could not get ${self.notRelevantTrainingKey}`, err);
                return;
            }
            if (json) notRelevantTrainingObj = JSON.parse(json);
            const exists = notRelevantTrainingObj.users.find(thisUser => thisUser.username === username);
            if (exists) return;
            notRelevantTrainingObj.users.push({
                username: username,
                tstamp: Date.now()
            });
            self.redisDbClient.set(self.notRelevantTrainingKey, JSON.stringify(notRelevantTrainingObj));
        });
    }

    markWordNotRelevant(message, socket) {
        const self = this;
        const word = message.data.word;
        if (!word) return;
        let notRelevantTrainingObj = this.createNewNotRelevantTrainingObj();
        this.redisDbClient.get(this.notRelevantTrainingKey, (err, json) => {
            if (err) {
                console.log(`Could not get ${self.notRelevantTrainingKey}`, err);
                return;
            }
            if (json) notRelevantTrainingObj = JSON.parse(json);

            // First, add this new entry to our global traingin:notRelevant object
            const exists = notRelevantTrainingObj.words.find(thisWord => thisWord.word === word);
            if (exists) return;
            notRelevantTrainingObj.words.push({
                word: word,
                tstamp: Date.now()
            });
            self.redisDbClient.set(self.notRelevantTrainingKey, JSON.stringify(notRelevantTrainingObj));

            // Second, delete the index:wordToComments:${thisWord} so that topCommentStats stops checking comments against this word
            self.redisDbClient.del(`index:wordToComments:${word}`);

            // Last, delete this word object from redis
            let wordType = 'word';
            const wordParts = word.split('_'); // JWW stopping point - word joins need a better delimeter
            if (wordParts.length === 2) wordType = 'bigram';
            if (wordParts.length === 3) wordType = 'trigram';
            self.redisDbClient.del(`word:${wordType}:${word}`);
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
            const wordParts = word.split('_'); // JWW stopping point - word joins need a better delimeter
            if (wordParts.length === 2) wordType = 'bigrams';
            if (wordParts.length === 3) wordType = 'trigrams';
            const wordIndex = comment[wordType].findIndex((thisWord) => thisWord.join('_') === word);
            if (wordIndex === -1) return;
            comment[wordType].splice(wordIndex, 1);

            // Second, remove all points which this word may have already earned
            const newPoints = {};
            for (const [pointKey, pointCount] of Object.entries(comment.points)) {
                if ( pointKey.indexOf(word) === -1 ) newPoints[pointKey] = pointCount;
            }
            comment.points = newPoints;

            // Lastly, keep a record on the comment itself that this word is not relevant (so not pounts acrue in the future)
            const exists = comment.training.notRelevant.words.find(thisWord => thisWord.word === word);
            if (!exists) {
                comment.training.notRelevant.words.push({
                    word: word,
                    tstamp: Date.now()
                });
            }

            self.redisDbClient.set(commentKey, JSON.stringify(comment));
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
            const symbolIndex = comment.symbols.findIndex((thisSymbol) => thisSymbol.symbol === symbol);
            if (symbolIndex === -1) return;
            comment.symbols.splice(symbolIndex, 1);
            self.redisDbClient.set(commentKey, JSON.stringify(comment));
        });
    }

    deleteComment(message, socket) {
        const commentId = message.data.commentId;
        if (!commentId) return;
        this.redisDbClient.del(`comment:${commentId}`);
    }

    createNewNotRelevantTrainingObj() {
        return {
            users: [], // array of objects {username: 'foo', tstamp: tstamp int (when user was marked not relevant via the trend training ui)}
            words: [] // array of objects {word: 'buy_gme', tstamp: tstamp int}
        };
    }

}; // end HbClientSocketDbResponses_admin

export default HbClientSocketDbResponses_admin;
