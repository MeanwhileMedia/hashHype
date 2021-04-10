import natural from 'natural';
import _ from 'underscore';
import util from 'util';
import RedisClient from '../utils/redisClient.js';
import symbolModel from '../utils/objectModels/symbol.js';

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
            dbName: 'short',
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
            dbName: 'short',
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
                if (key.indexOf('word:') !== -1) {
                    const word = gotObj;
                    const wordIndexKey = `index:wordToComments:${word.value.join('_!!_')}`; // _!!_ is the hashHype word delimeter
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
                                    self.redisDbClient.throttle.clearPendingSet(wordIndexKey);
                                    self.redisDbClient.set(wordIndexKey, JSON.stringify(commentsFound)); // don't throttle this update as the index innacuracy must be corrected immediately
                                }
                            });
                        });
                    });
                }
            });
        });
        // Pattern listener for all of the different word types.
        this.redisSubClient.psubscribe('__keyspace@0__:word*');
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
            self.applyPointsToCommentForWord(comment, word, () => {
                self.redisDbClient.throttle.set(`comment:${comment.id}`, comment, () => {
                    // Now take another look at the comment to see if it belongs in our topComments object
                    const commentClone = JSON.parse(JSON.stringify(comment));
                    self.reduceCommentPoints(commentClone);
                    const isCommentTopComment = self.isCommentTopComment(commentClone); //Alters this.topComments in-place. returns {isTopComment: bool, isNewTopComment: bool};
                    if (isCommentTopComment.isTopComment) {  // && isCommentTopComment.isNewTopComment) {
                        self.addSymbolsDataToComment(commentClone, () => { // Since this comment is new to the this.topComments object, we need to populate it's comment.symbols array.
                            self.determineCommentTopSymbol(commentClone);
                            self.minimizeComment(commentClone);
                            self.throttle.storeNewTopCommentsStats();
                            if (cback) cback();
                        });
                    } else if (isCommentTopComment.isTopComment) {
                        self.determineCommentTopSymbol(commentClone);
                        self.throttle.storeNewTopCommentsStats();
                        if (cback) cback();
                    }
                }); // end .set(`comment
            });
        }); // end .get(commentId
    }

    applyPointsToCommentForWord(comment, word, cback) {
        this.getWordPointCount(comment, word, (points) => {
            // Sum the new points total on the comment.words[wordRef] object. This provides a quick sum of how many points
            // this word earned this comment (starting from when the comment was created). It is not time bucketed. Is used for determining topSymbol for this comment.
            const wordString = word.value.join('_!!_'); // _!!_ is the hashHype word delimeter
            const commentWordRef = comment.words.find(wordRef => wordRef.word === wordString);
            if (commentWordRef) {
                commentWordRef.pointsEarned = commentWordRef.pointsEarned + points;
                // We will also look at every time this word occurred in ANY comment (since the word was first created) and transfter time based
                // points to the comment.points object. This allows us to later sum the points for this word in time buckets, and it also represents a total
                // comment point count which accounts for the words which were trending before the comment was created. A brand new comment may immediately become a top comment if it matches an existing trend.
                word.foundAt.forEach( (tstamp) => {
                    const wordCountKey = commentWordRef.word+'__'+tstamp;
                    comment.points[wordCountKey] = points; // storing as object auto resolves duplicates as comment.points is recalculated every time the word occurs in any comment.
                });
            }
            if (cback) cback();
        });
    }

    getWordPointCount(comment, word, cback) { // May alter comment object in-place. cback returns (points int, symbolObjects array)
        const self = this;
        //(0 points for words), 5 points when word is symbol
        //(5 for bigrams) x 2 when a symbol was in bigram (only multiplies max once)
        //(10 for trigrams) x 3 when a symbol was in bigram (only multiplies max once)
        let points = 0;
        let isSymbolMultiplier = 1;
        if (word.type === 'word'){
            points = 5; // we ONLY store word:word objects when they matched a symbol in extractWOrdsFromComments process
        }
        if (word.type === 'bigram') {
            points = 5;
            isSymbolMultiplier = 2;
        }
        if (word.type === 'trigram') {
            points = 10;
            isSymbolMultiplier = 3;
        }

        if(word.hasSymbols && word.hasSymbols.length > 0) {
            points = points * (isSymbolMultiplier*word.hasSymbols.length);
        }

        if (cback) cback(points);
    } //end getWordPointCount

    reduceCommentPoints(comment) {
        const self = this;
        // Converts an unordered array of points into a summed count for each word in time buckets.
        // points: { go__1614114246914: 2, go__1614114241877: 2, go__1614114236809: 2, go__1614114221815: 2 } =>
        // points: { '1Hr': { go: 8 }, etc... }
        // NOTE: this alters/replaces the points attribute in-place
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
        let isTopComment = false;
        let isNewTopComment = false; // will be true if isTopComment AND doesn't already exist on this.topComments
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
                isNewTopComment = true;

                // We also need to remove this topComment from the bucket if it's already there
                const existingCommentIndex = bucketComments.findIndex((existingComment) => existingComment.id === comment.id);
                if (existingCommentIndex !== -1) {
                    isNewTopComment = false;
                    const existingComment = bucketComments[existingCommentIndex];
                    comment.symbols = existingComment.symbols; // transfer over the symbols array so we don't have to fetch that data from redis again (this is a recurring topComment so it will have already received that data when it first started trending)
                    bucketComments.splice(existingCommentIndex, 1); // we remove the previous instance of this trending comment because it's point count will now be out-of-date
                }

                bucketComments.push(comment);
                isTopComment = true;
            }

            // Now re-sort this bucket descending
            bucketComments.sort((commentA, commentB) => {
                commentA.totalPoints[bucketKey]
                if (commentA.totalPoints[bucketKey] > commentB.totalPoints[bucketKey]) return -1;
                if (commentA.totalPoints[bucketKey] < commentB.totalPoints[bucketKey]) return 1;
                return 0;
            });
        }
        return {isTopComment: isTopComment, isNewTopComment: isNewTopComment};
    }

    addSymbolsDataToComment(comment, cback) { //alters comment in-place
        const self = this;
        comment.symbols = comment.symbols || [];
        const symbolKeysFromWordRefs = comment.words.map(wordRef => wordRef.hasSymbols);
        const allSymbolKeys = [...new Set(symbolKeysFromWordRefs.flat())]; // remove dups
        // console.log(`Populating comment:${comment.id} with full symbol objects:`, allSymbolKeys);
        if (!allSymbolKeys || allSymbolKeys.length === 0) {
            console.log(`A topComment has no symbols: ${comment.body}`);
            if (cback) cback();
            return;
        }
        // allSymbolObjectsForComment will be populated using getCached - our most performant redis get method, but data may be stale if other processes are manipulating the objects.
        const allSymbolObjectsForComment = [];
        allSymbolKeys.forEach((thisSymbolKey) => {
            self.redisDbClient.throttle.getCached(thisSymbolKey, (gotSymbol) => {
                if (gotSymbol) symbolModel.execGet(gotSymbol); // add the functionally populated symbol props. The ones produced by the customizable symbol.get function string. They are assigned to gotSymbol.funcdSymbolData and are used in UI.
                allSymbolObjectsForComment.push(gotSymbol);
                if (allSymbolObjectsForComment.length === allSymbolKeys.length) {
                    comment.symbols = allSymbolObjectsForComment.filter(Boolean); // Remove falsies (not found in redis)
                    if (cback) cback();
                }
            });
        });
    }

    determineCommentTopSymbol(comment) {
        // Sum the pointsEarned prop from each comment wordRef to determine the topSymbol for this comment. The topSymbol
        // represents the symbol which earned the most point SINCE the creation of the comment (rather than the most overall popular symbol in a specific timebucket).
        comment.topSymbol = null;
        if (!comment.symbols) return;
        const symbolPointCounts = {};
        let topSymbolKey = {key: null, pointsEarned: -1};
        comment.words.forEach((wordRef) => {
            wordRef.hasSymbols.forEach((symbolKey) => {
                symbolPointCounts[symbolKey] = symbolPointCounts[symbolKey] || 0;
                symbolPointCounts[symbolKey] = symbolPointCounts[symbolKey] + wordRef.pointsEarned;
                if (symbolPointCounts[symbolKey] > topSymbolKey.pointsEarned) topSymbolKey = {key: symbolKey, pointsEarned: symbolPointCounts[symbolKey]};
            });
        });
        if (!topSymbolKey.key) return;
        const topSymbolSymbol = topSymbolKey.key.split(':')[2]; // symbol:stock:gme
        const topSymbolObj = comment.symbols.find(thisSymbolObj => thisSymbolObj.symbol === topSymbolSymbol);
        if (topSymbolObj) {
            comment.topSymbol = topSymbolObj;
        }
    }

    minimizeComment(comment) { // alters comment in-place
        // Strip any data from this comment which isn't required for stats:topComments (not needed for UI rendering, or any other logic which depends on stats:topComments redis data)
        // 1. comment.points was already reduced to represent every word/word sequence which earned the comment points (see reduceCommentPoints). We don't need store all the word combinations to this.topComments.
        delete comment.words;
    }

    isDiscardComment(comment) {
        // This process includes rules around which comments should be excluded in trend analysis. Ie: comments that are from not relevant users
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

        // This function acts on changes to our training:notRelevant object. Once it detects a new value was added to trainingNotRelevant.lastAffected,
        // it starts an interval to repeatedly act on that change X times. This is because some of the async logic in respondToNewTraining will
        // be overwritten by in-process logic, and some now-irrelevant comments may cycle into our local this.topComments after others are removed.
        // Essentially, it may take several iterations on this logic to fully flush through cycling realtime data/
        self.activeTrainingCycleIterations = 5; // how many times should we repeat this logic
        self.activeTrainingCycleCount = self.activeTrainingCycleCount || 0; // how many times have we already repeated in active cycle
        if (self.activeTrainingCycleCount < self.activeTrainingCycleIterations) {
            self.activeTrainingCycleCount++;
            self.activeTrainingCycle = setTimeout(() => {
                self.respondToNewTraining();
            }, 5000);
        } else {
            self.activeTrainingCycleCount = 0;
            self.activeTrainingCycle = null;
            self.activeTrainingKeys = [];
        }

        self.activeTrainingKeys = self.activeTrainingKeys || [];
        if (this.trainingNotRelevant.lastAffected && this.trainingNotRelevant.lastAffected.length) {
            this.trainingNotRelevant.lastAffected.forEach((thisLastAffected) => {
                self.activeTrainingKeys.push(thisLastAffected.key);
            });
            this.trainingNotRelevant.lastAffected = [];
        }
        if (self.activeTrainingKeys.length === 0) return;
        console.log(`Now responding to training on changed keys:`, self.activeTrainingKeys);

        self.activeTrainingKeys.forEach((changedKey, index) => {
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
            // 3. If this training change deleted a comment, then it must also be locally deleted from this.topComments, and from redis throttle cache
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

    removeCommentFromTopComments(removeCommentId) { // Alters self.topComments in place
        const self = this;

        // first delete any throttled redis set/get commands for this comment.
        const commentRedisKey = `comment:${removeCommentId}`;
        self.redisDbClient.throttle.clearPendingGet(commentRedisKey);
        self.redisDbClient.throttle.clearPendingSet(commentRedisKey);

        // Then delete the instance of this object stored directly on stats:topComments
        const revisedTopComments = {timeBuckets: {}};
        for (const [bucketKey, bucketComments] of Object.entries(this.topComments.timeBuckets)) {
            revisedTopComments.timeBuckets[bucketKey] = revisedTopComments.timeBuckets[bucketKey] || [];
            bucketComments.forEach((thisComment, thisCommentIndex) => {
                if (thisComment.id !== removeCommentId) {
                    revisedTopComments.timeBuckets[bucketKey].push(thisComment);
                    return;
                }
                console.log(`Removing comment from ${this.topCommentsStatsKey} (${bucketKey}). Comment: ${removeCommentId}`);
            });
        }
        this.topComments.timeBuckets = revisedTopComments.timeBuckets;
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
