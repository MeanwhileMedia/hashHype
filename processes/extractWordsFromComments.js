import natural from 'natural';
import RedisClient from '../utils/redisClient.js';

import events from 'events';
events.EventEmitter.defaultMaxListeners = Infinity;

class ExtractWordsFromComments {

    // Step 1: strip out insignificant words like "it", "the" (built into PorterStemmer.tokenizeAndStem)
    // Step 2: tokenize and stem every remaining word (built into PorterStemmer.tokenizeAndStem)
    // Step 3: Store word object for every single word that is ALSO a symbol
    // Step 4: Store every bigram to redis as a word object
    // Step 5: Store every trigram to redis as a word object
    // Step 6: Add every found word:symbol, word:bigram, word:trigram, and symbol to the comment object, save to redis.
    // Step 7: As topWordStats continues to produce occurance counts - comments which contain topWords will be pointed accordingly, and maybe trend.

    constructor() {
        const self = this;
        this.redisSubClient = null;
        this.redisDbClient = null;
        this.initRedisSubClient(() => {
            self.initRedisDbClient(() => {
                self.syncTrainingNotRelevant();
                self.initKeyspaceSubscriptions();
            });
        });
    }

    initRedisSubClient(cback) {
        const self = this;
        new RedisClient({
            onConnect: (client) => {
                console.log('Connected new redis sub client for word extractor class.');
                self.redisSubClient = client;
                if(cback) cback();
            }
        });
    }

    initRedisDbClient(cback) {
        const self = this;
        new RedisClient({
            onConnect: (client) => {
                console.log('Connected new redis db client for word extractor class.');
                self.redisDbClient = client;
                if(cback) cback();
            }
        });
    }

    initKeyspaceSubscriptions() {
        const self = this;
        this.redisSubClient.on('pmessage', function (matchedPattern, patternWithKey, action){
            if (action !== 'set') return;
            // If this event was sent as part of the set pattern subcribed keyspace event, then it's "patternWithKey" will be: __keyspace@0__:comment:0b90a45d-283b-4716-aa14-ac9f99ac54b1
            let rawCommentKey = patternWithKey;
            rawCommentKey = rawCommentKey.replace('__keyspace@0__:', '');
            self.redisDbClient.get(rawCommentKey, (err, commentJson) => {
                if (err || !commentJson) {
                    console.log(err);
                    return;
                }
                self.redisDbClient.del(rawCommentKey); // We are going to reform the rawComment: into a comment:. Delete rawComment from redis.
                const comment = JSON.parse(commentJson);
                if (!comment || !comment.body) return;
                self.extractSymbols(comment, () => {
                    self.extractWordSequences(comment, () => {
                        self.redisDbClient.set(`newComment:${comment.id}`, JSON.stringify(comment));
                    });
                });
            });
        });
        this.redisSubClient.psubscribe('__keyspace@0__:rawComment*'); // flow for comments is rawComment -> newComment -> comment
    }

    extractSymbols(commentData, cback) {
        const self = this;

        //For now, we are no longer creating entries for individual words UNLESS they are symbols (for memory/performance reasons). See checkForSymbols function.
        self.checkForSymbols(commentData, (singleWordSymbols) => {
            let symbolsStoredCount = 0;
            if (!singleWordSymbols || singleWordSymbols.length === 0) {
                if (cback) cback();
                return;
            }
            console.log(`Comment contained symbols:`, singleWordSymbols, commentData.body);
            singleWordSymbols.forEach((symbolWord, index) => {
                const word = [symbolWord];
                if (self.isDiscardWord(word)) return;
                let wordData = self.newWordEntity({type: 'symbol', value: word});
                const key = self.generateWordEntityKey(wordData);
                self.redisDbClient.get(key, (err, json) => {
                    if (json) {
                        wordData = JSON.parse(json);
                    } else {
                        //console.log('New unique symbol commented:', word);
                    }
                    wordData.foundAt.unshift(Date.now());
                    commentData.words.push(wordData.value);
                    self.redisDbClient.set(key, JSON.stringify(wordData)); // by setting a change to this re-occurance of a symbol, the topCommentStats keyspace listener will trigger and calculate new topComments.

                    symbolsStoredCount++;
                    if (symbolsStoredCount === singleWordSymbols.length && cback) cback();
                });
            });
        });
    }

    extractWordSequences(commentData, cback) {
        const self = this;
        let totalSteps = 0; // to time our callback
        let stepsComplete = 0;

        const stemmedAndTokenizedSignificantWords = natural.PorterStemmer.tokenizeAndStem(commentData.body);
        const bigrams = natural.NGrams.bigrams(stemmedAndTokenizedSignificantWords);
        const trigrams = natural.NGrams.trigrams(stemmedAndTokenizedSignificantWords);
        totalSteps = bigrams.length + trigrams.length;

        bigrams.forEach((bigram) => {
            if (self.isDiscardWord(bigram)) return;
            let bigramData = self.newWordEntity({type: 'bigram', value: bigram});
            const key = self.generateWordEntityKey(bigramData);
            self.redisDbClient.get(key, (err, json) => {
                if (json) {
                    bigramData = JSON.parse(json);
                    //console.log('Found recurring bigram:', bigram);
                } else {
                    //console.log('New unique bigram:', bigram);
                }
                bigramData.foundAt.unshift(Date.now());
                commentData.bigrams.push(bigramData.value);
                self.redisDbClient.set(key, JSON.stringify(bigramData));

                stepsComplete++;
                if (stepsComplete === totalSteps && cback) cback();
            });
        });

        trigrams.forEach((trigram) => {
            if (self.isDiscardWord(trigram)) return;
            let trigramData = self.newWordEntity({type: 'trigram', value: trigram});
            const key = self.generateWordEntityKey(trigramData);
            self.redisDbClient.get(key, (err, json) => {
                if (json) {
                    trigramData = JSON.parse(json);
                    //console.log('Found recurring trigram:', trigram);
                } else {
                    //console.log('New unique trigram:', trigram);
                }
                trigramData.foundAt.unshift(Date.now());
                commentData.trigrams.push(trigramData.value);
                self.redisDbClient.set(key, JSON.stringify(trigramData));

                stepsComplete++;
                if (stepsComplete === totalSteps && cback) cback();
            });
        });

    }

    checkForSymbols(comment, cback) {
        this.checkForStockSymbols(comment, cback);
    }

    checkForStockSymbols(comment, cback) {
        const self = this;
        let singleWordSymbols = [];

        const commentTokens = new natural.WordPunctTokenizer().tokenize(comment.body);
        if (!commentTokens || !commentTokens.length) {
            if (cback) cback(singleWordSymbols);
            return;
        }
        let mgetSymbols = commentTokens.filter(token => {
            if (token.length > 5) return false;
            const isAllCaps = token.split('').filter(char => char.toUpperCase() === char);
            if (isAllCaps.length !== token.length) return false; // For now, we are enforcing that symbols must always be all caps
            return true;
        });
        mgetSymbols = [...new Set(mgetSymbols)]; // Filters out dups
        if (mgetSymbols.length === 0) {
            if (cback) cback(singleWordSymbols);
            return;
        }
        const checkForSymbolKeys = mgetSymbols.map(symbol => `symbol:stock:${symbol.replace('$', '')}`);
        this.redisDbClient.mget(checkForSymbolKeys, (err, foundSymbols) => {
            if(err || !foundSymbols) {
                if (cback) cback(singleWordSymbols);
                return;
            }
            foundSymbols = foundSymbols.filter(Boolean); // Returns null for not found items
            if (foundSymbols.length) {
                //console.log(`A comment contained symbol(s): ${comment.body}`, foundSymbols);
                foundSymbols.forEach((symbolJson, index) => {
                    const symbolData = JSON.parse(symbolJson);
                    comment.symbols.push(symbolData); // save a local copy of the full symbol data to this comment
                    singleWordSymbols.push(symbolData.symbol.toLowerCase()); // our singleWordSymbols array is returned to create individual word:symbol objects in redis
                });
            }
            if (cback) cback(singleWordSymbols);
        });
    }

    syncTrainingNotRelevant() {
        // This function gets training:notRelevant from redis (used to ignore word combos found in comments), and adds
        // a keyspace listener so local data is always synced with redis.
        const self = this;
        this.redisDbClient.get('training:notRelevant', (err, json) => {
            if (err || !json) return;
            self.trainingNotRelevant = JSON.parse(json);
        });
        if (self.trainingNotRelevantIsSynced) return;
        self.trainingNotRelevantIsSynced = true;
        self.redisSubClient.on('message', (channel, message) => {
            if (channel === '__keyspace@0__:training:notRelevant') self.syncTrainingNotRelevant();
        });
        self.redisSubClient.subscribe('__keyspace@0__:training:notRelevant');
    }

    isDiscardWord(word) { // word is in array form [symbolWord] or [bigram,word] etc
        // this process includes rules around which comments should be included in trend analysis. Ie: comments that are too long... comments that look like bots or spam, etc.
        let shouldDiscard = false;

        // If word has been marked as not relevant
        if (this.trainingNotRelevant) {
            const stringifiedWord = word.join('_');
            const notRelWordIndex = this.trainingNotRelevant.words.findIndex((thisWord) => thisWord.word === stringifiedWord);
            if (notRelWordIndex !== -1) shouldDiscard = true;
        }

        return shouldDiscard;
    }

    newWordEntity(initial = {}) { // Must provide value, and type
        // returns an initial state for a new word, bigram, trigram object
        return {
            value: initial.value, //an array of words. length 1 for type word, and for 2 bi and 3 tri gram
            type: initial.type, // 'word', 'bigram', 'trigram'
            foundAt: [], //array of timestamps for every time this entity was found in a raw comment
        }
    }

    generateWordEntityKey(word) {
        const wordEntityKey = `word:${word.type}:${word.value.join('_')}`;
        return wordEntityKey;
    }

}

const thisExtractor = new ExtractWordsFromComments();
export default ExtractWordsFromComments;
