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
                    self.syncTrainingNotRelevant();
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
                    const wordIndexKey = `index:wordToComments:${word.value.join('_')}`;
                    self.redisDbClient.throttle.get(wordIndexKey, (wordToCommentsIndex) => {
                        if (!wordToCommentsIndex) return;
                        let commentsChecked = 0; // So we know when all checkWordAgainstComment calls (async) have completed
                        const commentsFound = []; // if redis could not find one or more comments, then they should be deleted from this index.
                        wordToCommentsIndex.forEach((thisCommentId, index) => {
                            self.checkWordAgainstComment(word, thisCommentId, (err) => {
                                commentsChecked++;
                                if (!err) commentsFound.push(thisCommentId);
                                if (commentsChecked === wordToCommentsIndex.length && commentsFound.length !== wordToCommentsIndex.length) {
                                    // Looks like at least one of the comments for this word index was not in redis. Update the index object.
                                    self.redisDbClient.throttle.set(wordIndexKey, commentsFound);
                                }
                            });
                        });
                    });
                }
            });
        });
        // 1. The overall listener for new comments (so we can add listeners for recurrances of all of that comment's words)
        this.redisSubClient.psubscribe('__keyspace@0__:newComment*');
        // 2. Pattern listener for all of the different word types.
        this.redisSubClient.psubscribe('__keyspace@0__:word*');
        // 3. Update local copy of topComments in case another process has to alter it
        this.redisSubClient.on('message', (channel, message) => {
            if (channel === `__keyspace@0__:${this.topCommentsStatsKey}`) {
                self.redisDbClient.get(self.topCommentsStatsKey, (err, json) => {
                    if (json) self.topComments = JSON.parse(json);
                });
            }
        });
        this.redisSubClient.subscribe(`__keyspace@0__:${this.topCommentsStatsKey}`);

    }

    registerWordToCommentsIndex(comment, cback) { // a comment index (index:wordToComments:) is an array holding comment ids
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

    checkWordAgainstComment(word, commentId, cback) { // cback is used to pass back err message (or undefined on success)
        const self = this;
        self.redisDbClient.throttle.get(`comment:${commentId}`, (comment) => {
            if (!comment || self.isDiscardComment(comment)) {
                // if this comment couldn't be found in redis, then delete from top comment stats (may have beed deleted by training or redis LRU algo)
                console.log(`Missing comment in redis: ${commentId}`);
                self.removeCommentFromTopComments(commentId);
                if (cback) cback('comment404');
                return;
            }
            // Quickly apply the new point and save the comment back to redis
            self.applyPointsToCommentForWord(comment, word);
            self.redisDbClient.throttle.set(`comment:${comment.id}`, comment, () => {
                // Now take another look at the comment to see if it belongs in our topComments object
                const commentClone = JSON.parse(JSON.stringify(comment));
                self.reduceCommentPoints(commentClone);
                const foundNewTopComment = self.isCommentTopComment(commentClone); //Alters this.topComments in-place.
                if (foundNewTopComment) self.throttle.storeNewTopCommentsStats();
                if (cback) cback();
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
                reducedPoints['1Hr'][thisWord] = reducedPoints['1Hr'][thisWord] + pointCount;
            }
            if(now - msIn12Hr < thisWordTstamp) {
                reducedPoints['12Hr'][thisWord] = reducedPoints['12Hr'][thisWord] || 0;
                reducedPoints['12Hr'][thisWord] = reducedPoints['12Hr'][thisWord] + pointCount;
            }
            if(now - msInHr < thisWordTstamp) {
                reducedPoints['24Hr'][thisWord] = reducedPoints['24Hr'][thisWord] || 0;
                reducedPoints['24Hr'][thisWord] = reducedPoints['24Hr'][thisWord] + pointCount;
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

    isDiscardComment(comment) {
        // this process includes rules around which comments should be excluded in trend analysis. Ie: comments that are from not relevant users
        let shouldDiscard = false;

        // 1. has the user been marked as not relevant. Comments will be discarded first by the fetchRedditComments process, but consider
        // this a backup to catch any offending comments which may have already been saved to redis (before the not relevant rule was established)
        if (this.trainingNotRelevant) {
            const notRelUserIndex = this.trainingNotRelevant.users.findIndex((thisUser) => thisUser.username === comment.author.name);
            if (notRelUserIndex !== -1) {
                shouldDiscard = true;
                console.log(`Comment will be deleted because user ${comment.author.name} is now not relevant: ${comment.id}`);
                this.redisDbClient.del(`comment:${comment.id}`);
            }
        }

        return shouldDiscard;
    }

    respondToNewTraining() {
        const self = this;
        this.respondedToTrainingKeys = this.respondedToTrainingKeys || []; // Keep a local record so we don't accidentally act on a traing change more than once.

        const lastTrainedKeys = [];
        if (this.trainingNotRelevant.lastAffected && this.trainingNotRelevant.lastAffected.length) {
            this.trainingNotRelevant.lastAffected.forEach((thisLastAffected) => {
                const trainingChangeId = `${thisLastAffected.tstamp}__${thisLastAffected.key}`;
                if (self.respondedToTrainingKeys.indexOf(trainingChangeId) !== -1 ) return null; // Already acted on this specific training change
                self.respondedToTrainingKeys.push(trainingChangeId);
                lastTrainedKeys.push(thisLastAffected.key);
            });
        }
        if (lastTrainedKeys.length === 0) return;
        console.log(`Now responding to training on changed keys:`, lastTrainedKeys);
        lastTrainedKeys.forEach((changedKey, index) => {
            // 1. First we immediately delete any throttled redis get/set commands for this key. This is somewhat invasive because all registered cbacks for getting this key will be abandoned.
            //    However, this is an all-or-nothing decision: if an object which this process manipulates was altered outside this process, then this process can't continue any pending logic on a locally cached version of that object.
            self.redisDbClient.throttle.clearPendingGet(changedKey);
            self.redisDbClient.throttle.clearPendingSet(changedKey);
            // 2. If this is a user just marked not relevant, loop through this.topComments and delete any existing comments by that user.
            if (changedKey.indexOf('user:') !== -1) {
                const notRelevantUser = changedKey.replace('user:', '');
                for (const [bucketKey, bucketComments] of Object.entries(this.topComments.timeBuckets)) {
                    bucketComments.forEach((thisComment) => {
                        if (thisComment.author && thisComment.author.name === notRelevantUser) self.removeCommentFromTopComments(thisComment.id); // (also removes from redis throttle cache)
                    });
                }
            }
            // 3. If this is a new word being added to training:notRelevant - delete the index:wordToComments:${thisWord} so that topCommentStats stops checking comments against this word
            if (changedKey.indexOf('word:') !== -1) {
                const notRelevantWord = changedKey.slice(changedKey.lastIndexOf(':')+1);
                const confirmedNotRelevant = self.trainingNotRelevant.words.findIndex((thisWord) => thisWord.word === notRelevantWord); // verify that this word is also in the trainingNotRelevant.words array
                if (confirmedNotRelevant !== -1) {
                    const commentIndexKey = `index:wordToComments:${notRelevantWord}`;
                    self.redisDbClient.throttle.get(commentIndexKey, (commentIndex) => {
                        console.log('JWW', commentIndexKey, commentIndex);
                        self.redisDbClient.del(commentIndexKey);
                        self.redisDbClient.throttle.clearPendingGet(commentIndexKey);
                        self.redisDbClient.throttle.clearPendingSet(commentIndexKey);
                        self.removeWordFromComments(notRelevantWord, commentIndex);
                        self.removeWordPointsFromTopComments(notRelevantWord);
                    });
                }
            }
            // 4. If this training change deleted a comment, then it must also be locally deleted from this.topComments, and from redis throttle cache
            if (changedKey.indexOf('comment:') !== -1) {
                // The best we can do is just assume the training change invalidates the comment from being a top comment. If this assumption is wrong, then the comment may resurface as word pointing continues.
                const commentId = changedKey.replace('comment:', '');
                self.removeCommentFromTopComments(commentId); // (also removes from redis throttle cache)
            }
        });
    }

    syncTrainingNotRelevant() {
        // This function gets training:notRelevant from redis (used in discarding comments from flagged users), and adds
        // a keyspace listener so local data is always synced with redis.
        const self = this;
        this.redisDbClient.get('training:notRelevant', (err, json) => {
            if (err || !json) return;
            self.trainingNotRelevant = JSON.parse(json);
            self.respondToNewTraining();
        });
        if (self.trainingNotRelevantIsSynced) return;
        self.trainingNotRelevantIsSynced = true;
        self.redisSubClient.on('message', (channel, message) => {
            if (channel === '__keyspace@0__:training:notRelevant') self.syncTrainingNotRelevant();
        });
        self.redisSubClient.subscribe('__keyspace@0__:training:notRelevant');
    }

    removeCommentFromTopComments(commentId) { // Alters self.topComments in place
        const self = this;

        // first delete any throttled redis set/get commands for this comment.
        const commentRedisKey = `comment:${commentId}`;
        self.redisDbClient.throttle.clearPendingGet(commentRedisKey);
        self.redisDbClient.throttle.clearPendingSet(commentRedisKey);

        // Then delete the instance of this object stored directly on stats:topComments
        for (const [bucketKey, bucketComments] of Object.entries(this.topComments.timeBuckets)) {
            bucketComments.forEach((thisComment, thisCommentIndex) => {
                if (thisComment.id === commentId) {
                    console.log(`Deleting comment from ${this.topCommentsStatsKey} (${bucketKey}). Comment: ${commentId}`);
                    self.topComments.timeBuckets[bucketKey].splice(thisCommentIndex, 1);
                }
            });
        }
        this.throttle.storeNewTopCommentsStats();
    }

    removeWordPointsFromTopComments(removeWord) {
        // Loop through every top comment in all time buckets (from locally stored this.topComments). If we find a comment that earned points for provided word, that comment is deleted from top comments.
        const self = this;
        for (const [bucketKey, bucketComments] of Object.entries(this.topComments.timeBuckets)) {
            bucketComments.forEach((thisComment) => {
                for (const [pointsBucketKey, pointsBucketEntries] of Object.entries(thisComment.points)) {
                    for (const [thisPointedWord, thisPointedWordPointsCount] of Object.entries(pointsBucketEntries)) {
                        if (thisPointedWord === removeWord) {
                            // If this comment got any points for this word, fully remove from topComments. It will recirculate to get it's new point total and re-render if it still has a high score.
                            console.log(`A top comment earned points for a not relevant word (${removeWord}). Comment id: ${thisComment.id}`);
                            self.removeCommentFromTopComments(thisComment.id);
                        }
                    };
                };
            });
        }
    }

    removeWordFromComments(removeWord, fromCommentIds) {
        // Loop through every top comment in removeFromCommentIds. Fetch them from redis, remove points If we find a comment that earned points for removeWord.
        const self = this;
        fromCommentIds.forEach((commentId) => {
            const commentRedisKey = `comment:${commentId}`;
            self.redisDbClient.throttle.clearPendingGet(commentRedisKey);
            self.redisDbClient.throttle.clearPendingSet(commentRedisKey);
            self.redisDbClient.throttle.get(commentRedisKey, (comment) => {
                if (!comment) return;
                // First remove points
                let pointsRemoved = 0;
                for (const [pointsKey, pointsCount] of Object.entries(comment.points)) { // the points object strait from redis looks like: {"foo_bar__1616453254162": 5, etc...}
                    if (pointsKey.search(new RegExp(`^${removeWord}__`)) !== -1) {
                        pointsRemoved = pointsRemoved + pointsCount;
                        delete comment.points[pointsKey];
                    }
                };
                if (pointsRemoved) console.log(`Removing points for word ${removeWord} from redis comment id: ${comment.id}`);
                // then, remove it from the words/bigrams/trigrams array
                let wordType = 'words';
                const wordParts = removeWord.split('_');
                if (wordParts.length === 2) wordType = 'bigrams';
                if (wordParts.length === 3) wordType = 'trigrams';
                const wordIndex = comment[wordType].findIndex((thisWord) => thisWord.join('_') === removeWord);
                if (wordIndex !== -1) comment[wordType].splice(wordIndex, 1);
                // save back to redis immediately
                self.redisDbClient.set(commentRedisKey, JSON.stringify(comment)); // don't throttle this one since other processes may also be actively editing comment objects
            });
        });
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
