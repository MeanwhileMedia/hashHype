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

        this.pendingWordsToTopCommentIds = {}; // these id's are roughly estimated to become topComments. Confirmed during refreshTopComments. {word_!!_foo: [commentId1, commentId2], bar_!!_baz: [commentId3], etc}
        this.pendingCommentIdsToWords = {}; // this index is basically the reverse of pendingWordsToTopCommentIds. Both are used in refreshTopComments.
        this.topComments = this.newTopCommentsEntity();

        this.topWordsCounts = {}; // {foo_bar: 35, baz: 100, etc...} // caches counts for words found to be both top, or not.
        this.topWordsCountsMaxLength = 200;
        this.topWordsMinCount = 0;

        this.redisClient = null;
        this.maxTopCommentsPerBucket = 50;
        this.trackCommentsFor = 86400000; // ms (24hrs) How long will we keep updating redis comment objects with recurring word points

        this.storeNewTopCommentsStatsThrottleTime = 5000;
        this.throttle = {
            storeNewTopCommentsStats: _.throttle(this.storeNewTopCommentsStats, this.storeNewTopCommentsStatsThrottleTime).bind(this),
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
                    // We maintain 2 indexes of pending top words <> pending top comments. See refreshTopComments for how they are used.
                    self.pendingWordsToTopCommentIds[wordString] = self.pendingWordsToTopCommentIds[wordString] || [];
                    self.pendingWordsToTopCommentIds[wordString] = self.pendingWordsToTopCommentIds[wordString].concat(wordToCommentsIndex);
                    wordToCommentsIndex.forEach((thisCommentId) => {
                        self.pendingCommentIdsToWords[thisCommentId] = self.pendingCommentIdsToWords[thisCommentId] || [];
                        self.pendingCommentIdsToWords[thisCommentId].push(wordString);
                    });
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

    refreshTopComments(cback) {
        const self = this;
        // During the keyspace listener loop (for when any word gets a tstamp added to it's "foundAt" redis list) a very rough estimate is made for
        // which comments MIGHT become topComments. Those comment id's are added to "this.pendingWordsToTopCommentIds". This refreshTopComments function
        // then runs the full logic (in intervals) to apply points for every word in the comment and compares to all other pendingWordsToTopCommentIds AND existing
        // this.topComments to see which ones will be finalized into this.topComments and prepped for rendering.

        const pendingWordsToTopComments = self.pendingWordsToTopCommentIds; // save a local copy
        const pendingCommentIdsToWords = self.pendingCommentIdsToWords;
        self.pendingWordsToTopCommentIds = {}; // reset now as they will continue to be incoming
        self.pendingCommentIdsToWords = {};

        // At this point, we have prepared a record of all recently re-commented words (pendingWordsToTopComments and pendingCommentIdsToWords) which
        // were determined from our word:foundAt keyspace listener. However, we also need to add existing topComment words to this list because they need
        // to be kept up-to-date even if they haven't been re-commented since our last refreshTopComments interval.
        const allExistingWordToCommentIndexPromises = [];
        for (const [bucketKey, bucketComments] of Object.entries(this.topComments.timeBuckets)) {
            bucketComments.forEach((thisExistingTopComment) => {
                for (const [pointedWord, points] of Object.entries(thisExistingTopComment.points['24Hr'])) { // we use the 24Hr pont bucket because we want to update all stored point words, not just recently trended.
                    if (pendingWordsToTopComments[pointedWord]) continue; // Looks like this word was naturally re-comments because it's already a part of pendingWordsToTopComments. No need to re-add now.
                    pendingWordsToTopComments[pointedWord] = pendingWordsToTopComments[pointedWord] || [];
                    const wordIndexKey = `index:wordToComments:${pointedWord}`;
                    allExistingWordToCommentIndexPromises.push(new Promise( (resolve, reject) => {
                        self.redisClient.throttle.get(wordIndexKey, (wordToCommentsIndex) => {
                            if (!wordToCommentsIndex) {
                                resolve();
                                return;
                            }
                            wordToCommentsIndex.forEach((thisCommentId) => {
                                pendingWordsToTopComments[pointedWord].push(thisCommentId);
                                pendingCommentIdsToWords[thisCommentId] = pendingCommentIdsToWords[thisCommentId] || [];
                                pendingCommentIdsToWords[thisCommentId].push(pointedWord);
                            });
                            resolve();
                        });
                    }));
                };
            });
        };

        Promise.all(allExistingWordToCommentIndexPromises).then(() => {
            // We have recorded all relevant words and comments that need to be a part of this pointing refresh, but it was fast and dirty
            // with no checks for dups. We wait until now to resolve dup words and comments as to not bog down CPU before the refreshTopComments interval.
            for (const [wordString, commentIds] of Object.entries(pendingWordsToTopComments)) {
                pendingWordsToTopComments[wordString] =  [...new Set(commentIds)];
            };
            for (const [commentId, wordStrings] of Object.entries(pendingCommentIdsToWords)) {
                pendingCommentIdsToWords[commentId] =  [...new Set(wordStrings)];
            };

            // Proceed to set comment get promises, and point counting promises. After they all complete we can save the newly calculated self.topComments to redis.
            const allCommentGetPromises = [];
            for (let [thisCommentId, wordsForThisCommentId] of Object.entries(pendingCommentIdsToWords)) {
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
                        const isYoungComment = Date.now() - comment.foundAt < self.trackCommentsFor;
                        if (!isYoungComment) {
                            // ONLY add points and update redis for comments less than X milliseconds old.
                            console.log(`A tracked comment is now too old. Will remove: ${thisCommentId}`);
                            self.removeCommentFromAll(comment);
                            resolve(null);
                            return;
                        }
                        // Replace this commentId stored on pendingWordsToTopComments with this full comment object so can be used in next set of promises below.
                        wordsForThisCommentId.forEach((thisWord) => {
                            const commentIndex = pendingWordsToTopComments[thisWord].indexOf(thisCommentId);
                            if (commentIndex !== -1) pendingWordsToTopComments[thisWord][commentIndex] = comment;
                        });

                        resolve(comment);
                    }); // end self.redisClient.throttle.get(`comment
                })); // end allCommentGetPromises.push
            }; // end this.pendingCommentIdsToWords for loop

            Promise.all(allCommentGetPromises).then((allComments) => {
                const allCommentPointingPromises = [];
                const possibleTopComments = allComments.filter(Boolean); //remove null responses (was redis 404, or was discarded, etc)
                possibleTopComments.forEach((comment) => {
                    comment.words.forEach( (thisWordRef) => {
                        // Only run point updating on the words that just triggered new foundAt occurances
                        if (pendingCommentIdsToWords[comment.id].indexOf(thisWordRef.word) === -1) return;
                        allCommentPointingPromises.push(new Promise( (resolve, reject) => {
                            // first we must collect all comments which are getting points re-counted for this specific word re-occurance. This list
                            // is used by applyPointsToCommentForWord to deduct points for word re-uses by the same comment author.
                            const allCommentsWithThisWord = pendingWordsToTopComments[thisWordRef.word];

                            // Now we can proceed to add up comment.points for this word, and later determine if this comment is a topComment.
                            self.applyPointsToCommentForWord(comment, thisWordRef, allCommentsWithThisWord, () => {
                                resolve();
                            });
                        }));
                    });
                }); // end possibleTopComments.forEach

                Promise.all(allCommentPointingPromises).then(() => {
                    // Now take another look at each comment to see if it belongs in our topComments object
                    const allIsTopCommentPromises = [];
                    possibleTopComments.forEach((comment) => {
                        allIsTopCommentPromises.push(new Promise( (resolve, reject) => {
                            let isTopComment = self.isTopComment(comment); //Alters this.topComments in-place. returns {isTopComment: bool};
                            // Save the :comment again at this point so that it's saveCount prop is updated and subjected to db preserve logic. Remember that we cannot use throttled redis commands to utilize dynamic DB functionality.
                            self.redisClient.set(`comment:${comment.id}`, comment, () => {
                                if (!isTopComment.isTopComment) {
                                    resolve();
                                    return;
                                }
                                // Perform last remaining steps to mutate this comment object for use on stats:topComments
                                self.addSymbolsDataToComment(comment, () => { // To properly render this comment in the topCommentStats UI, we need to populate it's comment.symbols array.
                                    self.determineCommentTopSymbol(comment);
                                    //self.minimizeComment(commentClone);
                                    resolve();
                                });
                            });
                        }));
                    });

                    Promise.all(allIsTopCommentPromises).then(() => {
                        if (cback) cback();
                    });
                }); // end Promise.all(allCommentPointingPromises)
            }); // end Promise.all(allCommentGetPromises)
        }); // end Promise.all(allExistingWordToCommentIndexPromises)
    } // end refreshTopComments

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
        //(10 for trigrams) x 3 when a symbol(s) was in bigram (only multiplies max twice)
        let points = 0;
        let isSymbolMultiplier = 1;
        let maxSymbols = 1;
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
            maxSymbols = 2; // A word sequence must have at least ONE token that is not a symbol to be pointed for contextful meaning.
        }

        if(wordRef.hasSymbols && wordRef.hasSymbols.length > 0) {
            const multiplyForSymbolCount = Math.min(wordRef.hasSymbols.length, maxSymbols);
            points = points * (isSymbolMultiplier*multiplyForSymbolCount);
        }

        if (cback) cback(points);
    } //end getWordPointCount

    timeBucketWordPointsForComment(comment, wordRef, points, allCommentsWithThisWord, cback) { // alters comment in-place (updates comment.points)
        const self = this;
        const foundAtListKey = `word:${wordRef.word}:foundAt`;
        self.redisClient.throttle.lrange(foundAtListKey, 0, -1, (foundAtLrangeRes) => {
            if (!foundAtLrangeRes || !foundAtLrangeRes.length) {
                if (cback) cback();
                return;
            }
            const allFoundAtTstamps = [...foundAtLrangeRes]; // We copy because we edit this array in place. The original foundAtLrangeRes object may be passed to multiple throttled lrange cbacks.
            const startingTstampLength = allFoundAtTstamps.length;
            // console.log(`Now running timeBucketWordPointsForComment for word: ${wordRef.word} and comment: ${comment.id}`)

            // First loop through the provided allCommentsWithThisWord array to determine if we must strip foundAt timestamps
            // from roundedFoundAtTstamps. This is determined by a couple factors:
            // 1. When any of allCommentsWithThisWord contain the same author as comment (an author can't boost his own prior comment, and a single comment doesn't earn points for itself)
            // 2. When we find any duplicate authors in allCommentsWithThisWord (another user can only boost an authors comment ONCE PER WORD PER 24Hrs)
            // This will eliminate point count inflation for identical comments from a single user, or other foulplay to influence a trend.
            let deductFoundAtCount = 0;
            const commentTstampsForAuthorsOfThisWord = {}; // {agentOOjoe: [tstamp1, tstamp2], otherUser: [tstamp3, tstamp4], etc...} (where the tstamps are taken from comment.foundAt)
            allCommentsWithThisWord.forEach((thisComment) => {
                if (!thisComment.author || !thisComment.author.name) return;
                commentTstampsForAuthorsOfThisWord[thisComment.author.name] = commentTstampsForAuthorsOfThisWord[thisComment.author.name] || [];
                commentTstampsForAuthorsOfThisWord[thisComment.author.name].push(thisComment.foundAt);
            });
            for (const [thisAuthor, commentTstampsForThisAuthor] of Object.entries(commentTstampsForAuthorsOfThisWord)) {
                let keepMostRecentComment = false;
                if (thisAuthor !== comment.author.name) keepMostRecentComment = true; // Since thisAuthor is not the author of current comment, then just one of their comments should be kept for pointing.
                let mostRecentCommentTstamp = 0;
                commentTstampsForThisAuthor.forEach((thisCommentTstamp) => {
                    const indexOfMatchedFoundAtTstamp = allFoundAtTstamps.indexOf(`${thisCommentTstamp}`); // remember that allFoundAtTstamps is an array of string timestamps...
                    if (indexOfMatchedFoundAtTstamp === -1) {
                        console.warn(`Could not locate a foundAt timestamp (${thisCommentTstamp}) for word ${wordRef.word} which coincided with a comment by author "${thisAuthor}".`);
                        return;
                    } else {
                        // console.log(`Matched a foundAt timestamp (${thisCommentTstamp}) for word ${wordRef.word} to a comment by author "${thisAuthor}".`);
                    }
                    if (keepMostRecentComment && thisCommentTstamp > mostRecentCommentTstamp) mostRecentCommentTstamp = thisCommentTstamp;
                    allFoundAtTstamps.splice(indexOfMatchedFoundAtTstamp, 1);
                });
                if (keepMostRecentComment && mostRecentCommentTstamp) allFoundAtTstamps.push(mostRecentCommentTstamp);
                // if (thisAuthor === comment.author.name) {
                //     deductFoundAtCount = deductFoundAtCount + commentTstampsForThisAuthor.length;
                // } else {
                //     deductFoundAtCount = deductFoundAtCount + (commentTstampsForThisAuthor.length-1);
                // }
            };
            // console.log('Debugging word point deduction. Began with foundAt tstamps:', startingTstampLength, 'Expected end length:', startingTstampLength - deductFoundAtCount, 'Actual end length:', allFoundAtTstamps.length);

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
                if (!thisWordPoints[pointsTimeBucketKey][wordRef.word]) {
                    delete comment.points[pointsTimeBucketKey][wordRef.word]; // clear out old points
                } else {
                    comment.points[pointsTimeBucketKey][wordRef.word] = thisWordPoints[pointsTimeBucketKey][wordRef.word];
                }
            };
            if (cback) cback();
        }); // end lrange cback
    }

    isTopComment(comment) {
        // this function takes the comment count stats and determines if it is ranked as a top trending comment in any of the time buckets.
        // Alters this.topComments in-place AND comment in-place
        let isTopComment = false;
        for (const [bucketKey, bucketComments] of Object.entries(this.topComments.timeBuckets)) {
            let removedTopComment = null; // For logging
            let newTopComment = null; // For logging

            // First re-tally total points for this comment
            comment.totalPoints[bucketKey] = 0;
            Object.values(comment.points[bucketKey]).forEach((thisWordPoints) => {
                comment.totalPoints[bucketKey] = comment.totalPoints[bucketKey] + thisWordPoints;
            });

            // Next, always delete any existing copies of this comment (in this.topComments). Whether this incoming comment is found to be
            // a top comment or not, the previous copy will no longer belong on topComments.
            const existingCommentIndex = bucketComments.findIndex((existingComment) => existingComment.id === comment.id);
            if (existingCommentIndex !== -1) {
                const existingComment = bucketComments[existingCommentIndex];
                removedTopComment = existingComment;
                bucketComments.splice(existingCommentIndex, 1);
            }

            // Next figure out if it has enough points to become a topComment, possibly replacing a previous one.
            let minCountForBucket = 0;
            if (bucketComments.length >= this.maxTopCommentsPerBucket) {
                const lastPlaceComment = bucketComments[bucketComments.length - 1]; // the bucketComments are already sorted descending so just grab the last one.
                minCountForBucket = lastPlaceComment.totalPoints[bucketKey];
            }

            if (comment.totalPoints[bucketKey] > minCountForBucket) { // we have a winner, remove the loser and add our new topComment
                if (removedTopComment) {
                    removedTopComment = null;
                } else {
                    newTopComment = comment;
                }
                if (bucketComments.length >= this.maxTopCommentsPerBucket) removedTopComment = bucketComments.pop();
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

            // if (removedTopComment) console.log(`An existing topComment stopped trending (${bucketKey}). comment:${removedTopComment.id} - ${removedTopComment.body}`);
            // if (newTopComment && bucketKey === '1Hr') console.log(`A new topComment started trending (${bucketKey}). comment:${newTopComment.id} - ${newTopComment.body}`);
        }
        return {isTopComment: isTopComment};
    }

    addSymbolsDataToComment(comment, cback) { //alters comment in-place
        const self = this;
        comment.symbols = comment.symbols || [];
        const symbolKeysFromWordRefs = comment.words.map(wordRef => wordRef.hasSymbols);
        const allSymbolKeys = [...new Set(symbolKeysFromWordRefs.flat())]; // remove dups
        // console.log(`Populating comment:${comment.id} with full symbol objects:`, allSymbolKeys);
        if (!allSymbolKeys || allSymbolKeys.length === 0) {
            // console.log(`A topComment has no symbols: ${comment.body}`);
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

    reduceTopComments(cback) {
        const self = this;
        // This function contains logic to reform our true self.topComments (based only on language processing) TO a corrected
        // representation that is intended to improve UX during presentation. See below for an explanation of specific rules.
        for (const [bucketKey, bucketComments] of Object.entries(this.topComments.timeBuckets)) {
            // 1. Loop through all comments and inspect all points. If a comment has received points for multiple symbols (single word), hashHype
            //    removes points for all symbols EXCEPT the top scoring symbol, and the bottom scoring symbol.
            //    This keeps comments like "I like GME ADBE TSLA MVIS PLTR APPL" from dominating our topComments object.
            bucketComments.forEach( (thisBucketComment) => {
                if (!thisBucketComment.symbols || thisBucketComment.symbols.length <= 2) return;
                const allSymbolsForComment = thisBucketComment.symbols.map(symbol => symbol.symbol);
                let topScore = 0;
                let bottomScore = 0;
                for (const [thisPointedWord, thisPointsCount] of Object.entries(thisBucketComment.points[bucketKey])) {
                    if (allSymbolsForComment.indexOf(thisPointedWord) === -1) continue;
                    if (topScore < thisPointsCount) topScore = thisPointsCount;
                    if (bottomScore > thisPointsCount || bottomScore === 0) bottomScore = thisPointsCount;
                };
                let deductedPoints = 0;
                for (const [thisPointedWord, thisPointsCount] of Object.entries(thisBucketComment.points[bucketKey])) {
                    if (allSymbolsForComment.indexOf(thisPointedWord) === -1) continue;
                    if (thisPointsCount === topScore) {
                        topScore = -1; // Reset to prevent any more matches. We may have more than one symbol that tied for the top score. We will just select the first one.
                    } else if (thisPointsCount === bottomScore) {
                        bottomScore = -1;
                    } else {
                        deductedPoints = deductedPoints + thisPointsCount;
                        thisBucketComment.points[bucketKey][thisPointedWord] = 0;
                    }
                };
                // if (deductedPoints) console.log(`A comment contained too many symbols (${allSymbolsForComment.length}). Deducted ${deductedPoints} points from comment: ${thisBucketComment.body}`);
                // Re-tally total points for this comment
                thisBucketComment.totalPoints[bucketKey] = thisBucketComment.totalPoints[bucketKey] - deductedPoints;
            });

            // 2. Loop through all topComments and inspect each comment.topSymbol. Sum the total count for each symbol amoung all topComments.
            //    If a symbol is found to be a topSymbol 3 OR MORE times, we will discard all comments EXCEPT the top and bottom scoring
            //    topComments with that topSymbol. This keeps our UI from showing a set of topComments that all represent the same symbol.
            const indexesForBucketCommentsByTopSymbol = {}; // {GME: [0, 3, 4], etc...}
            const topScoringCommentsByTopSymbol = {}; // {GME: commentObj, ADBE: otherCommentObj, etc}
            const bottomScoringCommentsByTopSymbol = {}; // {GME: commentObj, ADBE: otherCommentObj, etc}
            bucketComments.forEach( (thisBucketComment, thisBucketCommentIndex) => {
                if (!thisBucketComment.topSymbol) return;
                indexesForBucketCommentsByTopSymbol[thisBucketComment.topSymbol.symbol] = indexesForBucketCommentsByTopSymbol[thisBucketComment.topSymbol.symbol] || [];
                indexesForBucketCommentsByTopSymbol[thisBucketComment.topSymbol.symbol].push(thisBucketCommentIndex);
                if (!topScoringCommentsByTopSymbol[thisBucketComment.topSymbol.symbol] ||
                    topScoringCommentsByTopSymbol[thisBucketComment.topSymbol.symbol].totalPoints[bucketKey] < thisBucketComment.totalPoints[bucketKey]
                ) {
                    topScoringCommentsByTopSymbol[thisBucketComment.topSymbol.symbol] = thisBucketComment;
                }
                if (!bottomScoringCommentsByTopSymbol[thisBucketComment.topSymbol.symbol] ||
                    bottomScoringCommentsByTopSymbol[thisBucketComment.topSymbol.symbol].totalPoints[bucketKey] > thisBucketComment.totalPoints[bucketKey]
                ) {
                    bottomScoringCommentsByTopSymbol[thisBucketComment.topSymbol.symbol] = thisBucketComment;
                }
            });
            const deleteCommentsAtBucketCommentsIndexes = []; // [0, 4, 5] - These will be the indexes of all comments in bucketComments that were determined to be duplicated topSymbols and will be completetely removed from self.topComments
            const topSymbolsThatOccuredTooOften = []; // just for logging
            for (const [thisTopSymbolString, commentIndexesInbucketComments] of Object.entries(indexesForBucketCommentsByTopSymbol)) {
                if (commentIndexesInbucketComments.length <= 2) continue;
                topSymbolsThatOccuredTooOften.push(thisTopSymbolString);
                commentIndexesInbucketComments.forEach((thisCommentIndexInbucketComments) => {
                    const topCommentIdForThisSymbol = topScoringCommentsByTopSymbol[thisTopSymbolString].id;
                    const bottomCommentIdForThisSymbol = bottomScoringCommentsByTopSymbol[thisTopSymbolString].id;
                    const thisCommentId = bucketComments[thisCommentIndexInbucketComments].id;
                    if (thisCommentId !== topCommentIdForThisSymbol && thisCommentId !== bottomCommentIdForThisSymbol) {
                        deleteCommentsAtBucketCommentsIndexes.push(thisCommentIndexInbucketComments);
                    }
                });
            };
            let newBucketComments = bucketComments;
            if (deleteCommentsAtBucketCommentsIndexes.length > 0) {
                newBucketComments = [];
                bucketComments.forEach( (thisBucketComment, thisBucketCommentIndex) => {
                    if (deleteCommentsAtBucketCommentsIndexes.indexOf(thisBucketCommentIndex) === -1) newBucketComments.push(thisBucketComment);
                });
                console.log(`Some topSymbols occurred too many times within our (${bucketKey}) topComments ${JSON.stringify(topSymbolsThatOccuredTooOften)}. ${deleteCommentsAtBucketCommentsIndexes.length} comments were deleted from topComments.`);
            }

            // 3. Now that we have finished reducing/correcting via our hashHype rules, this topComments timebucket needs to be resorted descending by points.
            newBucketComments.sort((commentA, commentB) => {
                commentA.totalPoints[bucketKey]
                if (commentA.totalPoints[bucketKey] > commentB.totalPoints[bucketKey]) return -1;
                if (commentA.totalPoints[bucketKey] < commentB.totalPoints[bucketKey]) return 1;
                return 0;
            });

            this.topComments.timeBuckets[bucketKey] = newBucketComments;
        } // end for this.topComments.timeBuckets

        if (cback) cback();
    } // end reduceTopComments

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
        if (self.storeNewTopCommentsStatsIsPending) {
            console.warn(`Detected overlap in calls to "storeNewTopCommentsStats" at ${Date.now()}. Cancelling most recent call until pending call completes...`);
            if (!self.storeNewTopCommentsStatsIsPendingTimeout) {
                self.storeNewTopCommentsStatsIsPendingTimeout = setTimeout(() => {
                    self.storeNewTopCommentsStatsIsPendingTimeout = null;
                    if (!self.storeNewTopCommentsStatsIsPending) return;
                    self.storeNewTopCommentsStatsIsPending = false;
                    console.warn(`Forcefully cleared a pending storeNewTopCommentsStats timeout.`)
                }, this.storeNewTopCommentsStatsThrottleTime * 4);
            }
            return;
        }
        self.storeNewTopCommentsStatsIsPending = true;
        self.refreshTopComments(() => {
            self.reduceTopComments(() => {
                self.redisClient.set(self.topCommentsStatsKey, self.topComments, () => {
                    self.storeNewTopCommentsStatsIsPending = false;
                    clearTimeout(self.storeNewTopCommentsStatsIsPendingTimeout);
                    self.storeNewTopCommentsStatsIsPendingTimeout = null;
                    console.log('Updated stats:topComments at time:', Date.now());
                });
            });
        });
    }

    logInspectTopComments() { // util for debugging
        const summTopComments = [];
        this.topComments.timeBuckets['1Hr'].forEach((thisTopComment) => {
            const thisSumm = {
                id: thisTopComment.id,
                body: thisTopComment.body,
                points: thisTopComment.points,
                totalPoints: thisTopComment.totalPoints
            };
            if (thisTopComment.topSymbol) {
                thisSumm.topSymbol = thisTopComment.topSymbol.symbol
            }
            summTopComments.push(thisSumm);
        })
        console.log(util.inspect(summTopComments, {depth: 5, colors: true}));
    }

}

const thisCommentsStats = new TopCommentsStats();
export default TopCommentsStats;
