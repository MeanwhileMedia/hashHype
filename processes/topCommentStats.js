import natural from 'natural';
import _ from 'underscore';
import util from 'util';
import RedisClient from '../utils/redisClient.js';

import events from 'events';
events.EventEmitter.defaultMaxListeners = Infinity;

class TopCommentsStats {
    constructor() {
        const self = this;
        this.topCommentsStatsKey = 'stats:topComments';
        this.topComments = this.newTopCommentsEntity();
        this.redisSubClient = null;
        this.redisDbClient = null;
        this.maxTopCommentsPerBucket = 10;
        this.throttle = {
            storeNewTopCommentsStats: _.throttle(this.storeNewTopCommentsStats, 5000).bind(this),
        };

        this.initRedisSubClient(() => {
            self.initRedisDbClient(() => {
                self.redisDbClient.get(this.topCommentsStatsKey, (err, json) => {
                    if (json) this.topComments = JSON.parse(json);
                    self.initKeyspaceSubscriptions();
                });
            });
        });
    }

    initRedisSubClient(cback) {
        const self = this;
        new RedisClient({
            onConnect: (client) => {
                console.log('Connected new redis sub client for topCommentStats class.');
                self.redisSubClient = client;
                if(cback) cback();
            }
        });
    }

    initRedisDbClient(cback) {
        const self = this;
        new RedisClient({
            onConnect: (client) => {
                console.log('Connected new redis db client for topCommentStats class.');
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
            let key = patternWithKey;
            key = key.replace('__keyspace@0__:', '');
            self.redisDbClient.throttle.get(key, (gotObj) => {
                if (!gotObj) return;
                if (key.indexOf('newComment:') !== -1) {
                    const comment = gotObj;
                    self.registerWordToCommentsIndex(comment, () => {
                        // We are going to reform the newComment into a comment and delete newComment version from redis.
                        self.redisDbClient.throttle.set(`comment:${comment.id}`, comment, () => {
                            self.redisDbClient.del(key);
                        });
                    });
                }
                if (key.indexOf('word:') !== -1) {
                    const word = gotObj;
                    self.redisDbClient.throttle.get(`index:wordToComments:${word.value.join('_')}`, (wordToCommentsIndex) => {
                        if (!wordToCommentsIndex) return;
                        wordToCommentsIndex.forEach((thisCommentId) => {
                            self.checkWordAgainstComment(word, thisCommentId);
                        });
                    });
                }
            });
        });
        // 1. The overall listener for new comments (so we can add listeners for recurrances of all of that comment's words)
        this.redisSubClient.psubscribe('__keyspace@0__:newComment*');
        // 2. Pattern listener for all of the different word types.
        this.redisSubClient.psubscribe('__keyspace@0__:word*');
    }

    registerWordToCommentsIndex(comment, cback) {
        const self = this;
        comment.words.concat(comment.bigrams, comment.trigrams).forEach((word) => {
            const thisIndexKey = `index:wordToComments:${word.join('_')}`;
            self.redisDbClient.throttle.get(thisIndexKey, (wordToCommentsIndex) => {
                wordToCommentsIndex = wordToCommentsIndex || [];
                if (wordToCommentsIndex.indexOf(comment.id) === -1) wordToCommentsIndex.push(comment.id);
                self.redisDbClient.throttle.set(thisIndexKey, wordToCommentsIndex, () => {
                    if (cback) cback();
                });
            });
        });
    }

    checkWordAgainstComment(word, commentId) {
        const self = this;
        self.redisDbClient.throttle.get(`comment:${commentId}`, (comment) => {
            if (!comment) return;
            // Quickly apply the new point and save the comment back to redis
            self.applyPointsToCommentForWord(comment, word);
            self.redisDbClient.throttle.set(`comment:${comment.id}`, comment, () => {
                // Now take another look at the comment to see if it belongs in our topComments object
                const commentClone = JSON.parse(JSON.stringify(comment));
                self.reduceCommentPoints(commentClone);
                const foundNewTopComment = self.isCommentTopComment(commentClone); //Alters this.topComments in-place.
                if (foundNewTopComment) self.throttle.storeNewTopCommentsStats();
            }); // end .set(`comment
        }); // end .get(commentId
    }

    applyPointsToCommentForWord(comment, word) {
        const wordCountMultiplier = this.getWordCountMultiplier(comment, word);
        word.foundAt.forEach( (tstamp) => {
            const wordCountKey = word.value.join('_')+'__'+tstamp;
            comment.points[wordCountKey] = wordCountMultiplier;
        });
    }

    getWordCountMultiplier(comment, word) {
        //(0 points for words), 5 points when word is symbol
        //(5 for bigrams) x 2 when a symbol was in bigram (only multiplies max once)
        //(10 for trigrams) x 3 when a symbol was in bigram (only multiplies max once)
        const commentSymbolsFlat = comment.symbols.map(symbolObj => symbolObj.symbol.toLowerCase());
        const commentSymbolNamesFlat = comment.symbols.map(symbolObj => symbolObj.name.toLowerCase());

        let points = 0;
        if (word.type === 'symbol'){
            points = 5;
            // console.log(`Comment earned ${points} points for symbol: ${word.value[0]} (comment:${comment.id})`);
            if (comment.topSymbol.points <= points) comment.topSymbol = {symbol: word.value[0], points: points}
        }
        if (word.type === 'bigram') {
            points = 5;
            let symbolsFound = false; // Only count one symbol within one bi/trigram
            word.value.forEach((wordPart, index) => {
                if ((commentSymbolsFlat.indexOf(wordPart) !== -1 || commentSymbolNamesFlat.indexOf(wordPart) !== -1) && !symbolsFound) {
                    symbolsFound = true;
                    points = points * 2;
                    console.log(`Comment earned x2 points (subtotal ${points}) for bigram symbol: ${wordPart} in ${JSON.stringify(word.value)} (comment:${comment.id})`);
                    if(comment.topSymbol.points <= points) comment.topSymbol = {symbol: wordPart, points: points}
                }
            });
        }
        if (word.type === 'trigram') {
            points = 10;
            let symbolsFound = false; // Only count one symbol within one bi/trigram
            word.value.forEach((wordPart, index) => {
                if ((commentSymbolsFlat.indexOf(wordPart) !== -1 || commentSymbolNamesFlat.indexOf(wordPart) !== -1) && !symbolsFound) {
                    symbolsFound = true;
                    points = points * 3;
                    console.log(`Comment earned x3 points (subtotal ${points}) for trigram symbol: ${wordPart} in ${JSON.stringify(word.value)} (comment:${comment.id})`);
                    if(comment.topSymbol.points <= points) comment.topSymbol = {symbol: wordPart, points: points}
                }
            });
        }
        return points;
    }

    reduceCommentPoints(comment) {
        // Converts an unordered array of points into a summed count for each word in time buckets.
        // points: { go__1614114246914: 2, go__1614114241877: 2, go__1614114236809: 2, go__1614114221815: 2 } =>
        // points: { '1Hr': { go: 8 }, etc... }
        // NOTE: this alters/replaces the points attribute in-place
        const self = this;
        const msInHr = 3600000;
        const msIn12Hr = 43200000;
        const msIn24Hr = 86400000;
        const reducedPoints = {
            '1Hr': {},
            '12Hr': {},
            '24Hr': {},
            //'all': {}
        };
        const now = Date.now();
        for (const [pointKey, pointCount] of Object.entries(comment.points)) {
            const pointKeySplit = pointKey.split('__');
            const thisWord = pointKeySplit[0];
            const thisWordTstamp = pointKeySplit[1];

            if(now - msInHr < thisWordTstamp) {
                reducedPoints['1Hr'][thisWord] = reducedPoints['1Hr'][thisWord] || 0;
                reducedPoints['1Hr'][thisWord]++;
            }
            if(now - msIn12Hr < thisWordTstamp) {
                reducedPoints['12Hr'][thisWord] = reducedPoints['12Hr'][thisWord] || 0;
                reducedPoints['12Hr'][thisWord]++;
            }
            if(now - msInHr < thisWordTstamp) {
                reducedPoints['24Hr'][thisWord] = reducedPoints['24Hr'][thisWord] || 0;
                reducedPoints['24Hr'][thisWord]++;
            }
            // reducedPoints['all'][thisWord] = reducedPoints['all'][thisWord] || 0;
            // reducedPoints['all'][thisWord]++;
        };
        comment.points = reducedPoints;
    }

    isCommentTopComment(comment) {
        // this function takes the comment count stats and determines if it is ranked as a top trending comment in any of the time buckets.
        // Alters this.topComments in-place.
        let commentIsTop = false;
        for (const [bucketKey, bucketComments] of Object.entries(this.topComments.timeBuckets)) {

            //First re-tally total points for this comment
            comment.totalPoints[bucketKey] = 0;
            Object.values(comment.points[bucketKey]).forEach((thisWordPoints) => {
                comment.totalPoints[bucketKey] = comment.totalPoints[bucketKey] + thisWordPoints;
            });

            //Next figure out if it has enough points to become a topComment, possibly replacing a previous one.
            let minCountForBucket = 0;
            if (bucketComments.length >= this.maxTopCommentsPerBucket) {
                const lastPlaceComment = bucketComments[bucketComments.length - 1]; // the bucketComments are already sorted descending so just grab the last one.
                minCountForBucket = lastPlaceComment.totalPoints[bucketKey];
            }

            if (comment.totalPoints[bucketKey] > minCountForBucket) { // we have a winner, remove the loser and add our new topComment
                if (bucketComments.length >= this.maxTopCommentsPerBucket) bucketComments.pop();

                // We also need to remove this topComment from the bucket if it's already there
                const existingCommentIndex = bucketComments.findIndex((existingComment) => existingComment.id === comment.id);
                if (existingCommentIndex !== -1) bucketComments.splice(existingCommentIndex, 1);

                this.compactCommentForTopComments(comment);
                bucketComments.push(comment);
                commentIsTop = true;
            }

            // Now re-sort this bucket descending
            bucketComments.sort((commentA, commentB) => {
                commentA.totalPoints[bucketKey]
                if (commentA.totalPoints[bucketKey] > commentB.totalPoints[bucketKey]) return -1;
                if (commentA.totalPoints[bucketKey] < commentB.totalPoints[bucketKey]) return 1;
                return 0;
            });
        }
        return commentIsTop;
    }

    compactCommentForTopComments(commentClone) {
        // BEFORE we add this new comment clone object to our local this.topComments, delete some properties to save on memory.
        // This only alters a copy of the comment that is stored directly on stats:topComments. The original commeny redis object keeps all of it's data.
        // Alters commentClone in-place.
        // 1. comment.points was already reduced to represent every word/word sequence which earned the comment points.
        //    We don't need store all the word combinations to this.topComments.
        delete commentClone.words;
        delete commentClone.bigrams;
        delete commentClone.trigrams;
    }

    newTopCommentsEntity(initial = {}) {
        // returns an initial state for a top comment stats
        return {
            absKey: this.topCommentsStatsKey,
            lastUpdated: Date.now(), // in case we want to rate limit this process
            timeBuckets: {
                '1Hr': [],
                '12Hr': [],
                '24Hr': [],
                // 'all': []
            },
            ui: {
                viewPath: '/ui/views/topTagNetworks.jsx'
            }
         }
    }

    storeNewTopCommentsStats() {
        this.topComments.lastUpdated = Date.now();
        this.redisDbClient.set(this.topCommentsStatsKey, JSON.stringify(this.topComments));
        console.log('Updated stats:topComments at time:', this.topComments.lastUpdated)
        //console.log(util.inspect(this.topComments, {depth: 10, colors: true}));
    }

}

const thisCommentsStats = new TopCommentsStats();
export default TopCommentsStats;
