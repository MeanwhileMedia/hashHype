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

        this.pendingTopCommentIds = {}; // these id's are roughly estimated to become topComments. Confirmed during refreshTopComments. {word_!!_foo: [commentId1, commentId2], bar_!!_baz: [commentId3], etc}
        this.topComments = this.newTopCommentsEntity();

        this.topWordsCounts = {}; // {foo_bar: 35, baz: 100, etc...} // caches counts for words found to be both top, or not.
        this.topWordsCountsMaxLength = 200;
        this.topWordsMinCount = 0;

        this.redisClient = null;
        this.maxTopCommentsPerBucket = 10;
        this.trackCommentsFor = 86400000; // ms (24hrs) How long will we keep updating redis comment objects with recurring word points
        this.throttle = {
            storeNewTopCommentsStats: _.throttle(this.storeNewTopCommentsStats, 5000).bind(this),
        };

        self.initRedisClient(() => {
            self.redisClient.get(this.topCommentsStatsKey, (topCommentStatsObj) => {
                if (topCommentStatsObj) this.topComments = topCommentStatsObj;
                self.initKeyspaceSubscriptions();
                self.syncTrainingNotRelevant();
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        this.redisClient = new RedisClient({
            onConnect: (client) => {
                console.log('Connected new redis sub client for topCommentStats class.');
                if(cback) cback();
            }
        });
    }

    initKeyspaceSubscriptions() {
        const self = this;
        this.redisClient.on('pmessage', function (matchedPattern, patternWithKey, action){
            if (action !== 'rpush') return;
            // If this event was sent as part of the set pattern subcribed keyspace event, then it's "patternWithKey" will be: __keyspace@0__:comment:0b90a45d-283b-4716-aa14-ac9f99ac54b1
            let wordString = patternWithKey;
            wordString = wordString.replace(/__keyspace@0__:word:|:foundAt/g, '');
            self.isTopWord(wordString, (isTopWord) => {
                if (!isTopWord) return;
                const wordIndexKey = `index:wordToComments:${wordString}`;
                self.redisClient.throttle.get(wordIndexKey, (wordToCommentsIndex) => {
                    if (!wordToCommentsIndex) return;
                    self.pendingTopCommentIds[wordString] = self.pendingTopCommentIds[wordString] || [];
                    self.pendingTopCommentIds[wordString] = self.pendingTopCommentIds[wordString].concat(wordToCommentsIndex);
                    self.throttle.storeNewTopCommentsStats();
                });
            });
        });
        // Pattern listener for any time a new timstamp is pushed to a word's foundAt list
        this.redisClient.psubscribe('__keyspace@0__:word:*:foundAt');
    }

    isTopWord(wordString, cback) {
        // check the length of this word's "foundAt" redis list. If it is found to belong on the locally stored this.topWordCounts, send true to cback
        const self = this;
        if (self.topWordsCounts[wordString] && self.topWordsCounts[wordString] >= self.topWordsMinCount) {
            if (cback) cback(true);
            return;
        }
        const wordFoundAtKey = `word:${wordString}:foundAt`;
        self.redisClient.llen(wordFoundAtKey, (thisFoundAtListLength) => {
            self.topWordsCounts[wordString] = thisFoundAtListLength;
            if (thisFoundAtListLength >= self.topWordsMinCount) {
                if (cback) cback(true);
            } else {
                if (cback) cback(false);
            }
        });

        // Set an interval to take care of dups and re-fetch the foundAt list lengths for all words which already exist on this.topWords
        if(self.topWordsRefreshInterval) return;
        self.topWordsRefreshInterval = setInterval(() => {
            // First sort them
            const topWordsCountsEntries = Object.entries(self.topWordsCounts);
            topWordsCountsEntries.sort(function(a, b) {
                return b[1] - a[1];
            });

            let refreshCountForWords = topWordsCountsEntries.map(x => x[0]);
            refreshCountForWords = refreshCountForWords.slice(0, self.topWordsCountsMaxLength);
            // console.log(`Will now refresh current top words:`, refreshCountForWords);
            self.topWordsMinCount = self.topWordsCounts[refreshCountForWords[refreshCountForWords.length-1]] || self.topWordsMinCount;
            self.topWordsCounts = {};
            console.log(`New topWordsMinCount: ${self.topWordsMinCount}`);
            refreshCountForWords.forEach((thisTopWord) => {
                self.isTopWord(thisTopWord);
            });
        }, 5000);
    }

    applyPointsToCommentForWord(comment, wordRef, allCommentsWithThisWord, cback) { // alters comment in-place (updates points object)
        const self = this;
        this.getWordPointCount(comment, wordRef, (points) => {
            // re-fetch from redis all of the foundAt tstamps for this word, and assign them to comment.points[timebucket][wordString] = totalWordPointsForThisTimebucket (int)
            self.timeBucketWordPointsForComment(comment, wordRef, points, allCommentsWithThisWord, () => {
                if (cback) cback();
            });
        });
    }

    getWordPointCount(comment, wordRef, cback) {
        const self = this;
        //(0 points for words), 5 points when word is symbol
        //(5 for bigrams) x 2 when a symbol was in bigram (only multiplies max once)
        //(10 for trigrams) x 3 when a symbol was in bigram (only multiplies max once)
        let points = 0;
        let isSymbolMultiplier = 1;
        if (wordRef.type === 'word'){
            points = 5; // we ONLY store word:word objects when they matched a symbol in extractWOrdsFromComments process
        }
        if (wordRef.type === 'bigram') {
            points = 5;
            isSymbolMultiplier = 2;
        }
        if (wordRef.type === 'trigram') {
            points = 10;
            isSymbolMultiplier = 3;
        }

        if(wordRef.hasSymbols && wordRef.hasSymbols.length > 0) {
            points = points * (isSymbolMultiplier*wordRef.hasSymbols.length);
        }

        if (cback) cback(points);
    } //end getWordPointCount

    timeBucketWordPointsForComment(comment, wordRef, points, allCommentsWithThisWord, cback) { // alters comment in-place (updates comment.points)
        const self = this;
        const foundAtListKey = `word:${wordRef.word}:foundAt`;
        self.redisClient.throttle.lrange(foundAtListKey, 0, -1, (allFoundAtTstamps) => {
            if (!allFoundAtTstamps || !allFoundAtTstamps.length) {
                if (cback) cback();
                return;
            }

            // First loop through the provided allCommentsWithThisWord array to determine if we must strip a 'deductFoundAtCount' of most recent timestamps from
            // allFoundAtTstamps. This deductFoundAtCount is determined by a couple factors:
            // 1. When any of allCommentsWithThisWord contain the same author as comment (an author can't boost his own prior comment, and a single comment doesn't earn points for itself)
            // 2. When we find any duplicate authors in allCommentsWithThisWord (another user can only boost an authors comment ONCE PER WORD PER 24Hrs)
            // This will eliminate point count inflation for identical comments from a single user, or other foulplay to influence a trend.
            let deductFoundAtCount = 0;
            const commentCountsForAuthorsOfThisWord = {}; // {agentOOjoe: 2, otherUser: 1, etc...}
            allCommentsWithThisWord.forEach((thisComment) => {
                if (!thisComment.author || !thisComment.author.name) return;
                commentCountsForAuthorsOfThisWord[thisComment.author.name] = commentCountsForAuthorsOfThisWord[thisComment.author.name] || 0;
                ++commentCountsForAuthorsOfThisWord[thisComment.author.name];
            });
            for (const [thisAuthor, commentCountForAuthorOfThisWord] of Object.entries(commentCountsForAuthorsOfThisWord)) {
                if (thisAuthor === comment.author.name) {
                    deductFoundAtCount = deductFoundAtCount + commentCountForAuthorOfThisWord;
                } else {
                    deductFoundAtCount = deductFoundAtCount + (commentCountForAuthorOfThisWord-1);
                }
            };
            // if (deductFoundAtCount) console.log(`Deducting ${deductFoundAtCount} word (${wordRef.word}) foundAt occurances (${deductFoundAtCount*points} points) from comment:${comment.id} because of duplicated user commenting.`);
            if (deductFoundAtCount !== 0) allFoundAtTstamps = allFoundAtTstamps.slice(0, deductFoundAtCount*-1); // slice off the bottom (tstamps in foundAt lists are sorted ascending)

            // Converts an ordered array of word foundAt tstamps into time bucketed points. Where "foo_bar" is word:  {1hr: {foo_bar: 234}, 12hr: etc...}
            // It then takes this timebucketed points object and merges into comment.points (overwriting any previous point counts for this word)
            const msInHr = 3600000;
            const msIn12Hr = 43200000;
            const msIn24Hr = 86400000;
            const thisWordPoints = {
                '1Hr': {},
                '12Hr': {},
                '24Hr': {}
            };
            const now = Date.now();
            allFoundAtTstamps.forEach((thisFoundAtTstamp) => { // thisFoundAtTstamp is actually a string, but JS will coerce it to an int during calc (subtract ONLY). https://www.codegrepper.com/code-examples/javascript/js+string+minus+number
                if(now - msInHr < thisFoundAtTstamp) {
                    thisWordPoints['1Hr'][wordRef.word] = thisWordPoints['1Hr'][wordRef.word] || 0;
                    thisWordPoints['1Hr'][wordRef.word] = thisWordPoints['1Hr'][wordRef.word] + points;
                }
                if(now - msIn12Hr < thisFoundAtTstamp) {
                    thisWordPoints['12Hr'][wordRef.word] = thisWordPoints['12Hr'][wordRef.word] || 0;
                    thisWordPoints['12Hr'][wordRef.word] = thisWordPoints['12Hr'][wordRef.word] + points;
                }
                if(now - msIn24Hr < thisFoundAtTstamp) {
                    thisWordPoints['24Hr'][wordRef.word] = thisWordPoints['24Hr'][wordRef.word] || 0;
                    thisWordPoints['24Hr'][wordRef.word] = thisWordPoints['24Hr'][wordRef.word] + points;
                }
            });
            // Now transfer into comment.points (which will be stored to redis inside comment object)
            for (const [pointsTimeBucketKey, allWordPointCountsForTimeBucket] of Object.entries(comment.points)) {
                comment.points[pointsTimeBucketKey][wordRef.word] = thisWordPoints[pointsTimeBucketKey][wordRef.word];
            };
            if (cback) cback();
        }); // end lrange cback
    }

    isTopComment(comment) {
        // this function takes the comment count stats and determines if it is ranked as a top trending comment in any of the time buckets.
        // Alters this.topComments in-place AND comment in-place
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
            self.redisClient.throttle.getCached(thisSymbolKey, (gotSymbol) => {
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
        const self = this;
        // Loop through comment.words, and cross against comment.points and comment.symbols to assign the winning symbol object to comment.topSymbol.
        let topSymbolKey = null;
        let curTopPointsCount = 0;
        comment.topSymbol = null;
        comment.words.forEach( (thisWordRef) => {
            if (!thisWordRef.hasSymbols || thisWordRef.hasSymbols.length === 0) return;
            const pointsForThisSymbolWord = comment.points['1Hr'][thisWordRef.word];
            if (!pointsForThisSymbolWord) return;
            if (pointsForThisSymbolWord < curTopPointsCount) return;
            // Right now we are just grabbing the first symbol from the wordRef. This is somewhat innacurate because
            // if the wordRed contains more than one symbol, we may not be grabbing the one that earned it the most points.
            topSymbolKey = thisWordRef.hasSymbols[0];
            curTopPointsCount = pointsForThisSymbolWord;
        });
        if (!topSymbolKey) return;
        const symbolSymbol = topSymbolKey.split(':').pop(); // assumes our symbol key pattern will always place thie symbol.symbol string last (i.e. symbol:stock:gme)
        const topSymbol = comment.symbols.find(thisSymbol => thisSymbol.symbol === symbolSymbol);
        comment.topSymbol = topSymbol || null;
    }

    // minimizeComment(comment) { // alters comment in-place
    //     // Strip any data from this comment which isn't required for stats:topComments (not needed for UI rendering, or any other logic which depends on stats:topComments redis data)
    //     delete comment.words;
    // }

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
                this.redisClient.del(`comment:${comment.id}`);
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
            self.redisClient.throttle.clearPendingGet(changedKey);
            self.redisClient.throttle.clearPendingSet(changedKey);
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
        this.redisClient.get('training:notRelevant', (trainingObj) => {
            if (!trainingObj) return;
            self.trainingNotRelevant = trainingObj;
            self.respondToNewTraining();
        });
        if (self.trainingNotRelevantIsSynced) return;
        self.trainingNotRelevantIsSynced = true;
        self.redisClient.on('message', (channel, message) => {
            if (channel === '__keyspace@0__:training:notRelevant') self.syncTrainingNotRelevant();
        });
        self.redisClient.subscribe('__keyspace@0__:training:notRelevant');
    }

    removeCommentFromTopComments(removeCommentId) { // Alters self.topComments in place
        const self = this;

        // first delete any throttled redis set/get commands for this comment.
        const commentRedisKey = `comment:${removeCommentId}`;
        self.redisClient.throttle.clearPendingGet(commentRedisKey);
        self.redisClient.throttle.clearPendingSet(commentRedisKey);

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

    removeCommentFromWordToCommentIndexes(removeComment) { // removeComment must be a full comment object because we are about to loop through it's wordRefs
        const self = this;
        removeComment.words.forEach((thisWordRef) => {
            const thisIndexKey = `index:wordToComments:${thisWordRef.word}`;
            self.redisClient.throttle.get(thisIndexKey, (thisWordToCommentsIndex) => {
                // console.log(`Removing comment ${removeComment.id} from ${thisIndexKey}`);
                const commentIdIndex = thisWordToCommentsIndex.indexOf(removeComment.id);
                if (commentIdIndex === -1) return;
                thisWordToCommentsIndex.splice(commentIdIndex, 1);
                self.redisClient.set(thisIndexKey, thisWordToCommentsIndex);
            });
        });
    }

    removeCommentFromAll(removeComment) {
        this.removeCommentFromTopComments(removeComment.id);
        this.removeCommentFromWordToCommentIndexes(removeComment);
        this.redisClient.del(`comment:${removeComment.id}`);
    }

    refreshTopComments(cback) {
        const self = this;
        // During the keyspace listener loop (for when any word gets a tstamp added to it's "foundAt" redis list) a very rough estimate is made for
        // which comments MIGHT become topComments. Those comment id's are added to "this.pendingTopCommentIds". This refreshTopComments function
        // then runs the full logic (in intervals) to apply points for every word in the comment and compares to all other pendingTopCommentIds AND existing
        // this.topComments to see which ones will be finalized into this.topComments and prepped for rendering.
        const commentIdsForNewWords = self.pendingTopCommentIds; // save a local copy
        const newWordsForCommentIds = {}; // {commentId1: ['foo_!!_bar', 'gme'], commentId2: ['tsla'], etc...} - it's a flipped version of self.pendingTopCommentIds
        const uniquePendingTopCommentIds = [];
        for (let [word, commentIdsForWord] of Object.entries(self.pendingTopCommentIds)) {
            commentIdsForWord.forEach((thisCommentId) => {
                if (uniquePendingTopCommentIds.indexOf(thisCommentId) === -1) uniquePendingTopCommentIds.push(thisCommentId);
                newWordsForCommentIds[thisCommentId] = newWordsForCommentIds[thisCommentId] || [];
                newWordsForCommentIds[thisCommentId].push(word);
            });
        };
        self.pendingTopCommentIds = {}; // reset now as they will continue to be incoming

        const allCommentGetPromises = [];
        uniquePendingTopCommentIds.forEach( (thisCommentId) => {
            allCommentGetPromises.push(new Promise( (resolve, reject) => {
                self.redisClient.throttle.get(`comment:${thisCommentId}`, (comment) => {
                    if (!comment) {
                        // if this comment couldn't be found in redis, then delete from top comment stats (may have beed deleted by training or redis LRU algo)
                        console.log(`Missing comment in redis: ${thisCommentId}`);
                        resolve(null);
                        return;
                    }
                    if (self.isDiscardComment(comment)) {
                        self.removeCommentFromAll(comment);
                        resolve(null);
                        return;
                    }
                    const isYoungComment = Date.now() - comment.createdUtc < self.trackCommentsFor;
                    if (!isYoungComment) {
                        // ONLY add points and update redis for comments less than X milliseconds old.
                        console.log(`A tracked comment is now too old. Will remove: ${thisCommentId}`);
                        self.removeCommentFromAll(comment);
                        resolve(null);
                        return;
                    }
                    resolve(comment);
                }); // end self.redisClient.throttle.get(`comment
            })); // end allCommentGetPromises.push
        }); // end this.pendingTopCommentIds.forEach

        Promise.all(allCommentGetPromises).then((allComments) => {
            const allCommentPointingPromises = [];
            const possibleTopComments = allComments.filter(Boolean); //remove null responses (was redis 404, or was discarded, etc)
            possibleTopComments.forEach((comment) => {
                allCommentPointingPromises.push(new Promise( (resolve, reject) => {
                    let wordsComplete = 0;
                    comment.words.forEach( (thisWordRef) => {
                        // Only run point updating on the words that just triggered new foundAt occurances
                        if (newWordsForCommentIds[comment.id].indexOf(thisWordRef.word) === -1) {
                            ++wordsComplete;
                            return;
                        }

                        // first we must collect all comments which are getting points re-counted for this specific word re-occurance. This list
                        // is used by applyPointsToCommentForWord to deduct points for word re-uses by the same comment author.
                        const allCommentsWithThisWord = [];
                        const commentIdsForThisWord = commentIdsForNewWords[thisWordRef.word];
                        if (commentIdsForThisWord) {
                            possibleTopComments.forEach((possibleTopComment) => {
                                if (commentIdsForThisWord.indexOf(possibleTopComment.id) !== -1) allCommentsWithThisWord.push(possibleTopComment);
                            });
                        }
                        // Now we can proceed to add up comment.points for this word, and later determine if this comment is a topComment.
                        self.applyPointsToCommentForWord(comment, thisWordRef, allCommentsWithThisWord, () => {
                            ++wordsComplete;
                            if (wordsComplete < comment.words.length) return; // Wait until all words (for this comment) are pointed before proceeding to topComment logic

                            // resolve this allCommentPointingPromise without waiting on next lines. addSymbolsDataToComment takes a long time and we don't want to hold this memory while we wait.
                            resolve();

                            // Now take another look at the comment to see if it belongs in our topComments object
                            const commentClone = JSON.parse(JSON.stringify(comment)); // this comment object may be a part of redis cached get so clone before we neuter it for topComments.
                            let isTopComment = self.isTopComment(commentClone); //Alters this.topComments in-place. returns {isTopComment: bool, isNewTopComment: bool};

                            // Save the :comment again at this point so that it's saveCount prop is updated and subjected to db preserve logic.
                            self.redisClient.set(`comment:${comment.id}`, comment); // Remember that we cannot use throttled redis commands to utilize dynamic DB functionality.

                            if (!isTopComment.isTopComment) return;
                            if (isTopComment.isNewTopComment) console.log(`Found new topComment:`, commentClone.body);

                            // Perform last remaining steps to mutate this comment object for use on stats:topComments
                            self.addSymbolsDataToComment(commentClone, () => { // To properly render this comment in the topCommentStats UI, we need to populate it's comment.symbols array.
                                self.determineCommentTopSymbol(commentClone);
                                //self.minimizeComment(commentClone);
                            });
                        }); // end applyPointsToCommentForWord
                    }); // end comment.words.forEach
                })); // end allCommentPointingPromises.push
            }); // end possibleTopComments.forEach
            Promise.all(allCommentPointingPromises).then(() => {
                if (cback) cback();
            });
        }); // end Promise.all(allCommentGetPromises)
    } // end refreshTopComments

    newTopCommentsEntity(initial = {}) {
        // returns an initial state for a top comment stats
        return {
            absKey: this.topCommentsStatsKey,
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
        const self = this;
        this.refreshTopComments(() => {
            self.redisClient.set(self.topCommentsStatsKey, self.topComments);
            console.log('Updated stats:topComments at time:', Date.now())
            //console.log(util.inspect(this.topComments, {depth: 10, colors: true}));
        });
    }

}

const thisCommentsStats = new TopCommentsStats();
export default TopCommentsStats;
