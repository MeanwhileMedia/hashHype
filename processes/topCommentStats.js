import util from 'util';
import { throttle } from 'throttle-debounce';
import yargs from 'yargs';
import natural from 'natural';
import RedisClient from '../utils/redisClient.js';
import commentModel from '../utils/objectModels/comment.js';
import wordModel from '../utils/objectModels/word.js';
import symbolModel from '../utils/objectModels/symbol.js';
import trainingModels from '../utils/objectModels/training.js';
import stopWords from '../utils/stopWords.js';

import events from 'events';
events.EventEmitter.defaultMaxListeners = Infinity;

const argv = yargs(process.argv.slice(2)).argv;

const naturalNGrams = natural.NGrams; // is object (naturalNGrams.ngrams(string or array)) - Can runs through a tokenizer when passed a string.

class TopCommentsStats {
    constructor() {
        const self = this;
        this.topCommentsStatsKey = 'stats:topComments'; // The resulting computed data produced by this process
        this.trainingNotRelevantKey = 'training:notRelevant';

        this.processPersistKey = 'process:topCommentStats:persistedState'; // see persistProcessState function
        this.processPersistInterval = null;
        this.processPersistIntervalTime = 5000;

        this.pendingWordsToTopCommentIds = {}; // these id's are roughly estimated to become topComments. Confirmed during refreshTopComments. {word_!!_foo: [commentId1, commentId2], bar_!!_baz: [commentId3], etc}
        this.pendingCommentIdsToWords = {}; // this index is basically the reverse of pendingWordsToTopCommentIds. Both are used in refreshTopComments.

        this.topComments = this.newTopCommentsEntity();
        this.pendingTopComments = {};  // { GME: [comment1, comment3], YOLO: [comment2, comment3, etc...]} }

        this.topWordsCounts = {}; // {foo_bar: 35, baz: 100, etc...} // caches counts for words found to be both top, or not.
        this.topWordsCountsMaxLength = 200;
        this.topWordsMinCount = 0;
        this.topWordsRefreshInterval = null;
        this.topWordsRefreshIntervalTime = 5000;
        this.lastIntervalTotalWordsCount = 0; // total new words that we reported via pubsub '__keyspace@0__:word:*:foundAt' in the last ${topWordsRefreshIntervalTime}ms
        this.lastIntervalTopWordsCount = 0; // How many words were deemed top words in the last ${topWordsRefreshIntervalTime}ms? for logging/debugging the impact of our "isTopWord" logic.
        this.minAvgPercentTopWords = 20; // If the rolling average of percent of words which are deemed top words falls below this number, topWordsMinCount will be adjust down in increments until we start hitting our min percent.
        this.groupSizeForAvgPercentTopWords = 5; // We will store the percentage of words which were topWords for this many topWordsRefreshIntervals. After, the averaged percentage becomes part of the logic to update topWordsMinCount.

        this.redisClient = null;
        this.maxTopComments = 100;
        this.minTopCommentsWithSymbols = 20;
        this.trackCommentsFor = 3600000; // ms (1hr) How long will we keep updating redis comment objects with recurring word points

        this.storeNewTopCommentsStatsThrottleTime = 5000;
        this.throttle = {
            storeNewTopCommentsStats: throttle(this.storeNewTopCommentsStatsThrottleTime, this.storeNewTopCommentsStats).bind(this),
        };

        self.initRedisClient(() => {
            self.persistProcessState(() => {
                self.redisClient.get(self.topCommentsStatsKey, (topCommentStatsObj) => {
                    if (topCommentStatsObj) self.topComments = topCommentStatsObj;
                    self.initKeyspaceSubscriptions();
                    self.syncTrainingNotRelevant();

                });
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
            ++self.lastIntervalTotalWordsCount;
            self.isTopWord(wordString, (isTopWord) => {
                if (!isTopWord) return;
                ++self.lastIntervalTopWordsCount;
                // Get all comments, less than 1hr old, which contain this word. For realtime point calculation, we only access new comments (to save on CPU).
                self.getWordToCommentsIndexForTimeRange(wordString, self.trackCommentsFor, (wordToCommentsIndex) => {
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
        // Pattern listener for any time a new timestamp is pushed to a word's foundAt list
        this.redisClient.psubscribe('__keyspace@0__:word:*:foundAt');
    }

    isTopWord(wordString, cback) {
        // Check the length of this words "foundAt" redis list to see if the words count is high enough to potentially effect topComments.
        const self = this;

        // If this word is found in the locally cached this.topWordCounts, can return bool to cback immediately.
        if (self.topWordsCounts[wordString]) {
            if (self.topWordsCounts[wordString] >= self.topWordsMinCount) {
                if (cback) cback(true);
            } else {
                if (cback) cback(false);
            }
            return;
        }

        // This incoming word was not yet cached to this.topWordCounts. Fetch the "foundAt" redis list length now.
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
            // First sort our cached self.topWordsCounts. We Will take the smallest one to establish a topWordsMinCount (see setTopWordsMinCount)
            const topWordsCountsEntries = Object.entries(self.topWordsCounts);
            topWordsCountsEntries.sort(function(a, b) { // sorts descending
                return b[1] - a[1];
            });

            let refreshCountForWords = topWordsCountsEntries.map(x => x[0]);
            refreshCountForWords = refreshCountForWords.slice(0, self.topWordsCountsMaxLength);
            self.setTopWordsMinCount(refreshCountForWords);

            // console.log(`Will now refresh current top words:`, refreshCountForWords);
            self.topWordsCounts = {};
            refreshCountForWords.forEach((thisTopWord) => {
                self.isTopWord(thisTopWord);
            });
        }, self.topWordsRefreshIntervalTime);
    }

    setTopWordsMinCount(refreshCountForWords) {
        const self = this;

        // First calc/log the percent of words which were deemed top words in the last topWordsRefreshInterval
        const percentTopWords = Math.floor((self.lastIntervalTopWordsCount / self.lastIntervalTotalWordsCount) * 100);
        console.log(`Current topWordsMinCount: ${self.topWordsMinCount}`);
        console.log(`Total top words in last ${self.topWordsRefreshIntervalTime}ms: ${self.lastIntervalTopWordsCount}/${self.lastIntervalTotalWordsCount} (${percentTopWords}%)`);
        self.lastIntervalTotalWordsCount = 0; // reset counters now
        self.lastIntervalTopWordsCount = 0;

        // Next try to calculate a rolling average percent of words which were deeemed topWords (if we have enough data). We use that number to adjust our new topWordsMinCount.
        self.pendingTopWordsPercentsForAvg = self.pendingTopWordsPercentsForAvg || [];
        if (!Number.isNaN(percentTopWords) && percentTopWords !== Infinity) self.pendingTopWordsPercentsForAvg.push(percentTopWords);
        if (self.pendingTopWordsPercentsForAvg.length < self.groupSizeForAvgPercentTopWords) return;

        const percentTopWordsRollingAvg = self.pendingTopWordsPercentsForAvg.reduce((a,b) => a + b, 0) / self.pendingTopWordsPercentsForAvg.length;
        let adjustedTopWordsMinCount = null;
        if (percentTopWordsRollingAvg < self.minAvgPercentTopWords) {
            adjustedTopWordsMinCount = Math.max(Math.floor(self.topWordsMinCount * .9), 1);
            console.log(`topWordsMinCount was adjusted down after not enough words (${percentTopWordsRollingAvg}%) were deemed topWords. ${self.topWordsMinCount}->${adjustedTopWordsMinCount}`);
        } else {
            adjustedTopWordsMinCount = Math.max(Math.ceil(self.topWordsMinCount * 1.1), 1);
            console.log(`topWordsMinCount was adjusted up to maintain CPU load. ${self.topWordsMinCount}->${adjustedTopWordsMinCount}`);
            // // Just roughly establish a minimum score based on our trimmed list of cached word counts (refreshCountForWords).
            // // We just take the count for the last word in refreshCountForWords (which has already been shortened to meet this.topWordsCountsMaxLength)
            // estimatedTopWordsMinCount = self.topWordsCounts[refreshCountForWords[refreshCountForWords.length-1]]; // refreshCountForWords is sorted descending
            // if (typeof estimatedTopWordsMinCount === 'number') self.topWordsMinCount = estimatedTopWordsMinCount;
        }

        self.topWordsMinCount = adjustedTopWordsMinCount;
        self.pendingTopWordsPercentsForAvg = []; // reset our group for calculating the rolling average
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
        // were determined from our word:foundAt keyspace listener. However, we also need to add existing topComment words (which previously earned points) to this
        // list because they need to be kept up-to-date even if they haven't been re-commented since our last refreshTopComments interval.
        const allExistingWordToCommentIndexPromises = [];
        this.topComments.comments.forEach((thisExistingTopComment) => {
            for (const [pointedWord, points] of Object.entries(thisExistingTopComment.points['24Hr'])) { // we use the 24Hr point bucket because we want to update all stored point words, not just recently trended.
                if (pendingWordsToTopComments[pointedWord]) continue; // Looks like this word was naturally re-commented because it's already a part of pendingWordsToTopComments. No need to re-add now.
                pendingWordsToTopComments[pointedWord] = pendingWordsToTopComments[pointedWord] || [];
                allExistingWordToCommentIndexPromises.push(new Promise( (resolve, reject) => {
                    self.getWordToCommentsIndexForTimeRange(pointedWord, self.trackCommentsFor, (wordToCommentsIndex) => { // For realtime logic, only update comments that are less than 1hr old
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

        Promise.all(allExistingWordToCommentIndexPromises).then(() => {
            // We have recorded all relevant words and comments that need to be a part of this pointing refresh, but it was fast and dirty
            // with no checks for dups. We wait until now to resolve dup words and comments as to not bog down CPU before the refreshTopComments interval.
            for (const [wordString, commentIds] of Object.entries(pendingWordsToTopComments)) {
                pendingWordsToTopComments[wordString] = [...new Set(commentIds)];
            };
            for (const [commentId, wordStrings] of Object.entries(pendingCommentIdsToWords)) {
                pendingCommentIdsToWords[commentId] = [...new Set(wordStrings)];
            };

            // Proceed to set comment get promises, and point counting promises. After they all complete we can save the newly calculated self.topComments to redis.
            const allCommentGetPromises = [];
            for (let [thisCommentId, wordsForThisCommentId] of Object.entries(pendingCommentIdsToWords)) {
                allCommentGetPromises.push(new Promise( (resolve, reject) => {
                    self.redisClient.throttle.get(`comment:${thisCommentId}`, (comment) => {
                        if (!comment) {
                            // if this comment couldn't be found in redis, then delete from top comment stats (may have beed deleted by training or redis LRU algo)
                            console.log(`Missing comment in redis: ${thisCommentId}`);
                            self.removeCommentFromAll({
                                comment: comment,
                                commentId: thisCommentId,
                                associatedWords: wordsForThisCommentId
                            });
                            resolve(null);
                            return;
                        }
                        if (self.isDiscardComment(comment)) {
                            self.removeCommentFromAll({
                                comment: comment,
                                commentId: thisCommentId,
                                associatedWords: wordsForThisCommentId
                            });
                            resolve(null);
                            return;
                        }
                        const isYoungComment = Date.now() - comment.foundAt < self.trackCommentsFor;
                        if (!isYoungComment) {
                            // ONLY add points and update redis for comments less than X milliseconds old.
                            console.log(`A tracked comment is now too old. Will remove: ${thisCommentId}`);
                            self.removeCommentFromAll({
                                comment: comment,
                                commentId: thisCommentId,
                                associatedWords: wordsForThisCommentId
                            });
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
                    // Before calculating points for this word, we will extract 2dGrams and store them as new word objects in redis. We do this before pointing so we can
                    // determine if this word is about to earn points on this comment for the first time (see extractNew2dGramsFromTopComment for more).
                    self.extractNew2dGramsFromTopComment(pendingCommentIdsToWords[comment.id], comment, (all2dGramStrings) => {
                        comment.words.forEach( (thisWordRef) => {
                            if (all2dGramStrings.indexOf(thisWordRef.word) !== -1 && pendingCommentIdsToWords[comment.id].indexOf(thisWordRef.word) === -1) {
                                // looks like the above extractNew2dGramsFromTopComment found a new 2dGram for this comment. Let's add it to our local record objects before proceeding.
                                pendingCommentIdsToWords[comment.id].push(thisWordRef.word);
                                pendingWordsToTopComments[thisWordRef.word] = pendingWordsToTopComments[thisWordRef.word] || [];
                                pendingWordsToTopComments[thisWordRef.word].push(comment);
                            }
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
                    }); // end extractNew2dGramsFromTopComment
                }); // end possibleTopComments.forEach

                Promise.all(allCommentPointingPromises).then(() => {
                    // Now take another look at each comment to see if it belongs in our topComments object
                    const finalPossibleTopComments = [];
                    possibleTopComments.forEach((comment) => {
                        if (self.isDiscardComment(comment)) { // we are gonna run every comment through isDiscardComment one last time (now that the comments were pointed).
                            self.removeCommentFromAll({comment: comment});
                            return;
                        }
                        finalPossibleTopComments.push(comment);
                        self.initCommentTopSymbols(comment); // alters comment in place - assigns comment.topSymbols
                    });

                    self.groupPendingTopCommentsByTopSymbols(finalPossibleTopComments); // assigns all finalPossibleTopComments to self.pendingTopComments
                    self.calcTotalPointsForPendingTopComments(); // alters self.pendingTopComments AND comments in place - assigns comment.totalPoints

                    // Now take a final pass at self.pendingTopComments and transfer to self.topComments to be saved to redis. We will also do any necc. cleanup/additions to each topComment to prep for rendering.
                    const allTopCommentCleanupPromises = [];
                    const allUniqueTopComments = self.reducePendingTopComments(); // returns an array of all comments which landed in any self.topComments timebucket. No dups.
                    allUniqueTopComments.forEach((thisTopComment) => {
                        allTopCommentCleanupPromises.push(new Promise( (resolve, reject) => {
                            // Save the comment: the comment has new point and topSymbols props. We also want it's saveCount prop to be updated and subjected to db preserve logic. Remember that we cannot use throttled redis commands to utilize dynamic DB functionality.
                            self.redisClient.set(`comment:${thisTopComment.id}`, commentModel.minimizeForDb(thisTopComment), () => {
                                self.addSymbolsDataToComment(thisTopComment, () => { // To properly render this comment in the topCommentStats UI, we need to populate it's comment.symbols array.
                                    resolve();
                                });
                            });
                        }));
                    });

                    Promise.all(allTopCommentCleanupPromises).then(() => {
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
        let isSymbolMultiplier = 2;
        let maxSymbols = 1;
        let ignoreTokenCount = 0;
        if (wordRef.type === 'word'){
            points = 5; // we ONLY store word:word objects when they matched a symbol in extractWOrdsFromComments process
        }
        if (wordRef.type === 'bigram') {
            const theseTokens = wordRef.word.split('_!!_');
            theseTokens.forEach((thisToken) => {
                if (stopWords.ignore.indexOf(thisToken) !== -1) ++ignoreTokenCount;
            });
            points = 2 - ignoreTokenCount;
        }
        if (wordRef.type === 'trigram') {
            const theseTokens = wordRef.word.split('_!!_');
            theseTokens.forEach((thisToken) => {
                if (stopWords.ignore.indexOf(thisToken) !== -1) ++ignoreTokenCount;
            });
            points = 6 - (ignoreTokenCount*2);
            maxSymbols = 2; // A word sequence must have at least ONE token that is not a symbol to be pointed for contextful meaning.
        }
        if (wordRef.type === '2dGram') {
            let seqCount = wordRef.word.split('__!!!!__').length;
            // our extractNew2dGramsFromTopComment function will collapse multiple pointed words into a single sequence when those pointed words are adjacent. i.e: first_!!_part__!!!!__lose_!!_monei_!!_you_!!_can_!!_lose
            // This essentially forms a new word type (beyond length trigram) and should not be penalized by basing our seqCount only on the '__!!!!__' delimeter.
            const theseTokens = wordRef.word.replaceAll('__!!!!__', '_!!_').split('_!!_');
            seqCount = Math.floor(Math.max(seqCount, theseTokens.length/3));
            // For 2dGrams, we handle ignoreTokenCount differently. We count the chars in each of our ignore tokens, and add them to our distance penalizer.
            let distance = wordRef.distance;
            theseTokens.forEach((thisToken) => {
                if (stopWords.ignore.indexOf(thisToken) !== -1) distance = distance + thisToken.length;
            });
            // The avg distance measurement penalizes the point count. The higher the distance, the less meaningful this 2dGram.
            const avgDistance = Math.floor(wordRef.distance / seqCount);
            points = (20 * seqCount) - avgDistance;
            maxSymbols = seqCount / 2; // For 2dGrams, we only award points for a max of 1 symbol per every other sequence (no GME__!!!!__APPL)
        }

        if(wordRef.hasSymbols && wordRef.hasSymbols.length > 0) {
            const multiplyForSymbolCount = Math.min(wordRef.hasSymbols.length, maxSymbols);
            points = points * (isSymbolMultiplier*multiplyForSymbolCount);
        }

        if (cback) cback(Math.max(0, Math.floor(points)));
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
            // console.log(`Now running timeBucketWordPointsForComment for word: ${wordRef.word} and comment: ${comment.id}`)

            // First loop through the provided allCommentsWithThisWord array to determine if we must strip foundAt timestamps
            // from allFoundAtTstamps. This is determined by a couple factors:
            // 1. When any of allCommentsWithThisWord contain the same author as comment (an author can't boost his own prior comment, and a single comment doesn't earn points for itself)
            // 2. When we find any duplicate authors in allCommentsWithThisWord (another user can only boost an authors comment ONCE PER WORD PER 24Hrs)
            // This will eliminate point count inflation for identical comments from a single user, or other foulplay to influence a trend.
            const commentsWithThisWordByAuthors = {}; // {agentOOjoe: [comment45, comment25], otherUser: [comment21, comment762], etc...}
            allCommentsWithThisWord.forEach((thisComment) => {
                if (!thisComment.author || !thisComment.author.name) return;
                commentsWithThisWordByAuthors[thisComment.author.name] = commentsWithThisWordByAuthors[thisComment.author.name] || [];
                commentsWithThisWordByAuthors[thisComment.author.name].push(thisComment);
            });
            for (const [thisAuthor, commentsWithThisWordByThisAuthor] of Object.entries(commentsWithThisWordByAuthors)) {
                let keepMostRecentComment = false;
                if (thisAuthor !== comment.author.name) keepMostRecentComment = true; // Since thisAuthor is not the author of current comment, then just one of their comments (the most recent) can be kept for pointing.
                let mostRecentCommentTstamp = 0;
                commentsWithThisWordByThisAuthor.forEach((thisCommentByThisAuthor) => {
                    const thisCommentTstamp = thisCommentByThisAuthor.foundAt;
                    const indexOfMatchedFoundAtTstamp = allFoundAtTstamps.indexOf(`${thisCommentTstamp}`); // remember that allFoundAtTstamps is an array of string timestamps...
                    if (indexOfMatchedFoundAtTstamp === -1) {
                        // Looks like we are checking against a comment which has a timestamp which is no longer present in the word:foundAt list. It was likely
                        // expired from the word:foundAt list but the comment was wrongly preserved as a part of topComments.
                        console.warn(`While verifying word point count (${wordRef.word}) for comment:${comment.id}, a re-occurance of that same word by another user could not be confirmed. The invalid re-occurance was in comment:${thisCommentByThisAuthor.id}`);
                        // Since we can't reconcile this mismatch, our next-most-accurate option is to delete the comment alltogether.
                        self.removeCommentFromAll({comment: thisCommentByThisAuthor});
                        return;
                    } else {
                        // console.log(`Matched a foundAt timestamp (${thisCommentTstamp}) for word ${wordRef.word} to a comment by author "${thisAuthor}".`);
                    }
                    if (keepMostRecentComment && thisCommentTstamp > mostRecentCommentTstamp) mostRecentCommentTstamp = thisCommentTstamp;
                    allFoundAtTstamps.splice(indexOfMatchedFoundAtTstamp, 1);
                });
                if (keepMostRecentComment && mostRecentCommentTstamp) allFoundAtTstamps.push(mostRecentCommentTstamp);
            };

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
                if (typeof thisWordPoints[pointsTimeBucketKey][wordRef.word] === 'undefined') { // we store point records that were calculated to 0
                    delete comment.points[pointsTimeBucketKey][wordRef.word]; // clear out old points
                } else {
                    comment.points[pointsTimeBucketKey][wordRef.word] = thisWordPoints[pointsTimeBucketKey][wordRef.word];
                }
            };
            if (cback) cback();
        }); // end lrange cback
    }

    initCommentTopSymbols(comment) {
        const self = this;
        const allSymbols = this.newTimeBucketObject(); // { '1Hr': {'symbol:key': pointsInt, 'symbol:word:GME': 265, etc}, etc... }
        comment.words.forEach( (thisWordRef) => {
            if (!thisWordRef.hasSymbols || thisWordRef.hasSymbols.length === 0) return;
            Object.keys(allSymbols).forEach((timeBucketKey) => {
                const pointsForThisSymbolWord = comment.points[timeBucketKey][thisWordRef.word];
                if (!pointsForThisSymbolWord) return;
                thisWordRef.hasSymbols.forEach((thisSymbolKey) => {
                    allSymbols[timeBucketKey][thisSymbolKey] = allSymbols[timeBucketKey][thisSymbolKey] || 0;
                    allSymbols[timeBucketKey][thisSymbolKey] = allSymbols[timeBucketKey][thisSymbolKey] + pointsForThisSymbolWord;
                });
            });
        });
        const allSymbolsSorted = this.newTimeBucketObject('arrays'); // {'1Hr': ['symbol:key', 'symbol:word:GME'] } - where the keys in each array are sorted by the points they could earn for comment
        for (const [timeBucketKey, pointsBySymbol] of Object.entries(allSymbols)) {
            const pointsBySymbolArr = Object.entries(allSymbols[timeBucketKey]);
            pointsBySymbolArr.sort((symbolPointsA, symbolPointsB) => {
                return symbolPointsB[1] - symbolPointsA[1]; // sorts by points descending
            });
            allSymbolsSorted[timeBucketKey] = pointsBySymbolArr.map(symbolPoints => symbolPoints[0]);
        };

        // At this point, we assign ALL the comment symbols to topSymbols. When it runs through "groupPendingTopCommentByTopSymbols",
        // the topSymbols object will be reduced to represent only the symbols which earned this comment a place on topComments.
        // console.log(`comment:${comment.id} pending topSymbols:`, allSymbols);
        comment.topSymbols = allSymbols;
        comment.topSymbolsSorted = allSymbolsSorted; // This is a TEMP prop that should not be persisted to redis.
    }

    assignHighAndLowTopSymbols(comment, timeBucketKey, highSymbolKey, highSymbolRecord) { // returns true if high symbol could be added, false if not
        const self = this;
        // The maxSharedHighTopSymbols config is to set how many topComments can share the same comment.topSymbolHigh.key. If we let infinite topComments
        // have the same high topSymbol, then even when a comment is deemed topComment by an overall high score, it would wrongly try to render it's high topSymbol, and we'd have dup symbols presented.
        const maxSharedHighTopSymbols = 2;
        const sumTopSymbolsTotalPoints = () => {
            const highPoints = comment.topSymbolHigh[timeBucketKey].points || 0;
            const lowPoints = comment.topSymbolLow[timeBucketKey].points || 0;
            comment.topSymbolsTotalPoints[timeBucketKey] = highPoints + lowPoints;
        };

        comment.topSymbolHigh = comment.topSymbolHigh || self.newTimeBucketObject();
        const pendingTopSymbolHigh = {key: highSymbolKey, points: comment.topSymbols[timeBucketKey][highSymbolKey]};

        // topSymbolLow does not have any compete logic. We allow infinite topComments to share the same topSymbolLow.
        comment.topSymbolLow = comment.topSymbolLow || self.newTimeBucketObject();
        if (comment.topSymbolsSorted[timeBucketKey].length >= 2) {
            const lowSymbolKey = comment.topSymbolsSorted[timeBucketKey][comment.topSymbolsSorted[timeBucketKey].length-1];
            comment.topSymbolLow[timeBucketKey] = {key: lowSymbolKey, points: comment.topSymbols[timeBucketKey][lowSymbolKey]};
        }

        if (comment.topSymbolLow[timeBucketKey].key === pendingTopSymbolHigh.key) {
            sumTopSymbolsTotalPoints();
            return false;
        }

        highSymbolRecord[timeBucketKey][highSymbolKey] = highSymbolRecord[timeBucketKey][highSymbolKey] || [];
        if (highSymbolRecord[timeBucketKey][highSymbolKey].length < maxSharedHighTopSymbols) {
            highSymbolRecord[timeBucketKey][highSymbolKey].push(comment);
            comment.topSymbolHigh[timeBucketKey] = pendingTopSymbolHigh;
            sumTopSymbolsTotalPoints();
            return true;
        }

        // there are already 2 comments which have this symbol set as their high symbol. Compare to choose one.
        let removeVsCommentIndex = null;
        let prevBeatScore = 0;
        const commentScore = comment.topSymbols[timeBucketKey][highSymbolKey];
        highSymbolRecord[timeBucketKey][highSymbolKey].forEach((vsComment, index) => {
            const vsCommentScore = vsComment.topSymbols[timeBucketKey][highSymbolKey];
            if(commentScore > vsCommentScore){ // this comment scores higher on this symbol than the vsComment
                if (prevBeatScore < vsComment.topSymbols[timeBucketKey][highSymbolKey]) {
                    prevBeatScore = vsCommentScore;
                    removeVsCommentIndex = index;
                }
            }
        });
        if (removeVsCommentIndex == null) {
            sumTopSymbolsTotalPoints();
            return false;
        }

        // We have a displacedComment which means this comment high symbol can be set, then we can try to re-place the displacedComment
        comment.topSymbolHigh[timeBucketKey] = pendingTopSymbolHigh;

        const displacedComment = highSymbolRecord[timeBucketKey][highSymbolKey].splice(removeVsCommentIndex, 1, comment)[0];
        // console.log(`Displaced comment:${displacedComment.id} can't have a high topSymbol of ${highSymbolKey} because it scored lower than comment:${comment.id}. Updated highSymbolRecord:`, util.inspect(highSymbolRecord[timeBucketKey], {depth: 5, colors: true}));
        // Try to find a new home for this displacedComment
        if (displacedComment.topSymbolsSorted[timeBucketKey].length >= 2) { // if it has enough symbols
            const prevHighSymbolIndex = displacedComment.topSymbolsSorted[timeBucketKey].indexOf(highSymbolKey);
            const nextHighSymbolKey = displacedComment.topSymbolsSorted[timeBucketKey][prevHighSymbolIndex+1];
            displacedComment.topSymbolHigh[timeBucketKey] = {};
            if (nextHighSymbolKey) self.assignHighAndLowTopSymbols(displacedComment, timeBucketKey, nextHighSymbolKey, highSymbolRecord);
        }

        sumTopSymbolsTotalPoints();
        return true;
    } // end assignHighAndLowTopSymbols

    groupPendingTopCommentsByTopSymbols(possibleTopComments) {
        const self = this;
        // self.pendingTopComments is a temporary object populated during a batch of calls to isTopComment. Is used to group all potential top comments
        // into symbol buckets so our function can then select just X number of comments for each symbol when transferring this.pendingTopComments to this.topComments
        self.pendingTopComments = {}; // reset for this batch of incoming topComments. Will be boiled down and transferred to this.topComments after this batch is complete.

        const highSymbolRecord = this.newTimeBucketObject(); // {'1Hr': {symbol:stock:GME: [comment2, comment1]}, etc...} This is used when determining highSymbolKey below. We only select 2 comments to represent any given symbol (by having it occupy the higher pointing comment.topSymbols)
        const commentsByTopSymbol = this.newTimeBucketObject(); // {'1Hr': {'symbol:stock:GME': [(index3)comment4, (index18)comment2, (index434)comment1], 'symbol:stock:YOLO': etc... }, '12Hr': etc...}
        possibleTopComments.forEach((comment) => {
            comment.topSymbolsTotalPoints = this.newTimeBucketObject('integers');
            Object.keys(commentsByTopSymbol).forEach((timeBucketKey) => {
                if (Object.keys(comment.topSymbols[timeBucketKey]).length === 0) {
                    commentsByTopSymbol[timeBucketKey]['noSymbols'] = commentsByTopSymbol[timeBucketKey]['noSymbols'] || [];
                    commentsByTopSymbol[timeBucketKey]['noSymbols'].push(comment);
                    return;
                }
                for (const [symbolKey, commentsPointsForSymbol] of Object.entries(comment.topSymbols[timeBucketKey])) {
                    // Add it to it's spot with all other comments that have this symbol
                    commentsByTopSymbol[timeBucketKey][symbolKey] = commentsByTopSymbol[timeBucketKey][symbolKey] || [];
                    commentsByTopSymbol[timeBucketKey][symbolKey].push(comment);
                };

                // Now we must determine the high and low scoring symbols for this comment. These are the only symbols that will
                // contribute points later when comment.totalPoints is calculated.
                comment.topSymbolsSorted[timeBucketKey].some((thisHighSymbolKey) => { // step down descending through topSymbols until one returns true for being assigned, or none do.
                    comment.topSymbolHigh[timeBucketKey] = {}; // reset now before recalculating
                    comment.topSymbolLow[timeBucketKey] = {};
                    return self.assignHighAndLowTopSymbols(comment, timeBucketKey, thisHighSymbolKey, highSymbolRecord);
                });
                // console.log(`topSymbolHigh (${comment.topSymbolHigh[timeBucketKey].key}) and topSymbolLow (${comment.topSymbolLow[timeBucketKey].key}) were determined for comment:${comment.id}. topSymbolsTotalPoints (${timeBucketKey}): ${comment.topSymbolsTotalPoints[timeBucketKey]}`, comment.topSymbols[timeBucketKey]);
            }); // end Object.keys(commentsByTopSymbol).forEach(
        }); // end possibleTopComments.forEach(
        // console.log(`topSymbolHigh and topSymbolLow were assigned to all pending topComments:`, util.inspect(highSymbolRecord, {depth: 5, colors: true}));

        Object.keys(commentsByTopSymbol).forEach((timeBucketKey) => {
            const commentIdsInThisTimeBucket = [];
            for (const [symbolKey, commentsForSymbol] of Object.entries(commentsByTopSymbol[timeBucketKey])) {
                self.pendingTopComments[symbolKey] = self.pendingTopComments[symbolKey] || [];
                // If this commentsForSymbol array is for the faux symbol "noSymbols", then we will keep them all and continue loop. They will be selectively removed later after totalPoints are calculated.
                if (symbolKey === 'noSymbols') {
                    self.pendingTopComments[symbolKey] = self.pendingTopComments[symbolKey].concat(commentsForSymbol);
                    continue;
                }
                // We must sort the commentsForSymbol for this timeBucket (because next we will shift and pop to determine the high and low scoring comments for this symbol)
                commentsForSymbol.sort((commentA, commentB) => {
                    return commentB.topSymbolsTotalPoints[timeBucketKey] - commentA.topSymbolsTotalPoints[timeBucketKey];
                });
                // console.log(`All pending topComments for symbol ${symbolKey}:`, util.inspect(commentsForSymbol, {depth: 4, colors: true}));
                commentsForSymbol.some((thisCommentForSymbol) => {
                    if (commentIdsInThisTimeBucket.indexOf(thisCommentForSymbol.id) === -1) {
                        commentIdsInThisTimeBucket.push(thisCommentForSymbol.id);
                        self.pendingTopComments[symbolKey].push(thisCommentForSymbol);
                        return true; // break some loop. We have added our top scorer.
                    }
                });
                commentsForSymbol.reverse().some((thisCommentForSymbol) => {
                    if (commentIdsInThisTimeBucket.indexOf(thisCommentForSymbol.id) === -1) {
                        commentIdsInThisTimeBucket.push(thisCommentForSymbol.id);
                        self.pendingTopComments[symbolKey].push(thisCommentForSymbol);
                        return true; // break some loop. We have added our bottom scorer.
                    }
                });
                // console.log(`Kept pending topComments for symbol ${symbolKey}:`, util.inspect(self.pendingTopComments[timeBucketKey][symbolKey], {depth: 4, colors: true}));
            };
        });
        // console.log(`Pending topComments by topSymbols:`, util.inspect(self.pendingTopComments, {depth: 4, colors: true}));
    } // end groupPendingTopCommentsByTopSymbols

    calcTotalPointsForPendingTopComments() {
        const self = this;
        // Sum total points for this comment BUT with some rules for how many symbols will count towards total, etc.
        for (const [symbolKey, comments] of Object.entries(self.pendingTopComments)) {
            comments.forEach((thisComment) => {
                for (const [timeBucketKey, prevPoints] of Object.entries(thisComment.totalPoints)) {
                    thisComment.totalPoints[timeBucketKey] = 0;
                    thisComment.words.forEach((thisWordRef) => {
                        const pointsForThisWord = thisComment.points[timeBucketKey][thisWordRef.word];
                        if (!pointsForThisWord) return;
                        if (thisWordRef.hasSymbols.length === 0) {
                            // No symbols on this word sequence. Just add the points without any deduction logic.
                            thisComment.totalPoints[timeBucketKey] = thisComment.totalPoints[timeBucketKey] + pointsForThisWord;
                            return;
                        }
                        const topSymbolHighKey = thisComment.topSymbolHigh[timeBucketKey].key;
                        const topSymbolLowKey = thisComment.topSymbolLow[timeBucketKey].key
                        if (thisWordRef.hasSymbols.length && (topSymbolHighKey || topSymbolLowKey)) {
                            let discardWordPoints = false;
                            if (thisWordRef.hasSymbols.length > 2) { // at most, this word can contain our high and low topSymbol. If it has more symbols than that than we must discard.
                                discardWordPoints = true;
                            } else {
                                thisWordRef.hasSymbols.some((thisWordRefSymbolKey) => {
                                    if (thisWordRefSymbolKey !== topSymbolHighKey && thisWordRefSymbolKey !== topSymbolLowKey) {
                                        discardWordPoints = true;
                                        return true; // break some loop
                                    }
                                });
                            }
                            if (discardWordPoints) {
                                // console.log(`Word ${thisWordRef.word} earns no points for comment:${thisComment.id} because the word has symbols which were not present in comment.topSymbols['${timeBucketKey}']`, thisComment.topSymbols[timeBucketKey]);
                                return;
                            }
                            thisComment.totalPoints[timeBucketKey] = thisComment.totalPoints[timeBucketKey] + pointsForThisWord;
                        }
                    });
                }; // end for Object.entries(thisComment.totalPoints)) {
            }); // end comments.forEach((thisComment) => {
        }; // end for Object.entries(self.pendingTopComments)) {

    } // end calcTotalPointsForPendingTopComments

    reducePendingTopComments() {
        const self = this;
        const topCommentsClone = self.newTopCommentsEntity();
        const allUniqueTopComments = []; // this is our return value. A flattened and de-duped collection of all comments that made it into any topComments timebucket.
        const allUniqueTopCommentsIds = [];

        const finalTopCommentIds = [];
        const finalTopComments = []; // sorted by points ascending
        for (const [thisSymbolKey, pendingTopCommentsForThisSymbol] of Object.entries(self.pendingTopComments)) {
            pendingTopCommentsForThisSymbol.forEach((thisComment) => {
                if (finalTopCommentIds.indexOf(thisComment.id) !== -1) return;
                finalTopCommentIds.push(thisComment.id);
                finalTopComments.push(thisComment);
                if (allUniqueTopCommentsIds.indexOf(thisComment.id) === -1) {
                    // console.log(`comment:${thisComment.id} will be stored to ${self.topCommentsStatsKey}: ${thisComment.body}`);
                    allUniqueTopCommentsIds.push(thisComment.id);
                    allUniqueTopComments.push(thisComment);
                }
            });
        }
        // Last thing is to sort this final set of topComments descending (totalPoints)
        finalTopComments.sort((commentA, commentB) => {
            return commentB.totalPoints['1Hr'] - commentA.totalPoints['1Hr'];
        });
        // And trim off the lowest scoring comments (until we have the minimum required comments with symbols)
        let topCommentsWithSymbolsCount = 0;
        finalTopComments.some((thisTopComment) => {
            topCommentsClone.comments.push(thisTopComment);
            if (thisTopComment.topSymbolHigh['1Hr'].key || thisTopComment.topSymbolLow['1Hr'].key) ++topCommentsWithSymbolsCount;
            if (topCommentsWithSymbolsCount >= self.minTopCommentsWithSymbols || topCommentsClone.comments.length >= self.maxTopComments) return true; // we have all we need break loop
        });

        self.topComments.comments = topCommentsClone.comments;
        return allUniqueTopComments;
    }

    extractNew2dGramsFromTopComment(newlyPointedWordsForComment, comment, cback) { //alters comment in-place. cback returns an array of all 2dGrams currently in comment.
        // This is the last step (before saving to redis) performed on every newly pointed comment that has been deemed a topComment. We will inspect all words (word sequences) in this comment which have earned points,
        // and generate 2dGrams. 2dGrams are clustered word sequences that represent order. Then, future comments can earn points not just for re-commenting the same word sequences, but for commenting two or more
        // word sequences IN THE SAME ORDER as a past comment. For example:
        // Step 1: A new (stemmed) comment 'Hey reddit guy insane stuff GME is awesome and is going rocket moon Makes me happy comment about stocks and money'
        // Step 2: Some time passes and other users comment "guy_!!_insane" and "GME" and "going_!!_rocket_!!_moon" and "happy_!!_comment". extractNew2dGramsFromTopComment will create the following 2dGrams ONLY from the sequences which have earned points:
            // [ 'guy_!!_insane__!!!!__GME', (clusters of 2)
            //   'GME__!!!!__going_!!_rocket_!!_moon',
            //   'going_!!_rocket_!!_moon__!!!!__happy_!!_comment',
            //   'guy_!!_insane__!!!!__GME__!!!!__going_!!_rocket_!!_moon', (clusters of 3)
            //   'GME__!!!!__going_!!_rocket_!!_moon__!!!!__happy_!!_comment',
            //   'guy_!!_insane__!!!!__GME__!!!!__going_!!_rocket_!!_moon__!!!!__happy_!!_comment', (clusters of 4)
            //   etc... there is currently no limit on how long a cluster can be (other than the comment length max), and longer clusters are awarded more points when re-commented.
            // ]
            // (note that '__!!!!__' is the sequence delimeter within a sequence cluster (2dGram). _!!_ is the word delimeter within a sequence.)
        // Step 3: Each new 2dGram is saved as a new redis word entity, and added to wordToCommentsIndex and foundAt list - just like our symbols/bigrams/trigrams.
        // Step 4: More time passes, and new comments contain the same 2dGrams, receive points accordingly (see applyPointsToCommentForWord). Note that when a comment creates a new 2dgram within itself for the first time, it does not gain points until the next time.
        const self = this;
        const all2dGramStrings = []; // array wordRef.word strings (of word.type == 2dGram)

        // If this comment has less than 2 words which have earned, or will soon earn points, then we can't create a 2dGram and should return immediately.
        let previouslyPointedWordsForComment = Object.keys(comment.points['24Hr']);
        if (previouslyPointedWordsForComment.length + newlyPointedWordsForComment.length < 2) {
            // console.log(`comment:${comment.id} does not have enough pointed words to create any 2dGrams.`);
            if (cback) cback(all2dGramStrings);
            return;
        }
        const validWordsFor2dGram = [...new Set(previouslyPointedWordsForComment.concat(newlyPointedWordsForComment))]; // combine and remove dups

        // Only proceed if validWordsFor2dGram contains at least one word which is not already present in previouslyPointedWordsForComment. We know that when a comment earns points for a word for the first time,
        // two things occur: 1. Points are calculated for that word, and is set to comment.points. 2. extractNew2dGramsFromTopComment is run because this newly pointed word may result in a new 2dGram. This 2nd step only ever needs to occur once because comment.body is static.
        if (validWordsFor2dGram.length <= previouslyPointedWordsForComment.length) {
            // console.log(`Already created all 2dGrams for comment:${comment.id} which could result from incoming points for words:`, newlyPointedWordsForComment);
            if (cback) cback(all2dGramStrings); // as this is an early return to improve performance, we will wrongly pass an empty array for all2dGrams
            return;
        }

        // Now take all the pointed words for this comment, condense them, and get them in the correct order.
        // We use a charachter index map because some of the pointed word sequences will overlap and we can only count each token once (i.e. "guy_!!_insane" AND "guy_!!_insane_!!_stuff" both earned points)
        let pointedWordsOrdered = {}; // {'{charIndex11}': 'g', '12': 'u', '13': 'y', '14': '_', '15': 'i', '16': 'n', '17': 's', '18': 'a', '19': 'n', '20': 'e', '28': 'G', '29': 'M', etc...}
        comment.words.forEach((thisWordRef) => {
            if (thisWordRef.type === '2dGram') return;
            if (validWordsFor2dGram.indexOf(thisWordRef.word) === -1) return;

            const thisWordString = thisWordRef.word.replaceAll('_!!_', ' '); // For this logic our word delimeter must be only 1 char (because our word indexes are based on a stemmed body with single space delimeters)
            thisWordRef.index.forEach((thisIndex) => { // remember that a word sequence may occur more than once in a single comment
                const startIndex = thisIndex;
                for (let curIndex = startIndex; curIndex < startIndex+thisWordString.length; curIndex++) {
                    pointedWordsOrdered[curIndex] = thisWordString[curIndex-startIndex];
                }
            });
        });
        // console.log('comment.stemmedBody', comment.stemmedBody);
        // console.log('pointedWordsOrdered', pointedWordsOrdered);

        // Determine the index of each condensed pointed word within stemmed body
        const all2dGramSequencesWithIndex = []; //[ [{seqIndex11}, 'guy_insane'], [28, 'GME'] , etc...}
        let curSequence = '';
        let curSequenceStartIndex = null;
        let prevCharIndex = null;
        for (let [thisCharIndex, thisChar] of Object.entries(pointedWordsOrdered)) {
            if (prevCharIndex === null) {
                curSequenceStartIndex = thisCharIndex;
                prevCharIndex = thisCharIndex;
            }
            if (prevCharIndex < thisCharIndex-1) {
                // looks like we just finished re-combining a sequence
                all2dGramSequencesWithIndex.push([parseInt(curSequenceStartIndex), curSequence])
                curSequenceStartIndex = thisCharIndex;
                curSequence = '';
            }
            curSequence = curSequence + thisChar;
            prevCharIndex = thisCharIndex;
        }
        all2dGramSequencesWithIndex.push([curSequenceStartIndex, curSequence])
        // console.log('all2dGramSequencesWithIndex', all2dGramSequencesWithIndex);

        // Now we will go through all possible combinations of pointed sequences using natural ngrams. Then we calculate
        // the "distance" property for each combination which will become part of this a wordRef object on this comment (wordRef.type == '2dGram')
        const all2dGrams = []; // [ [{distance: 7, index: 11, word:guy_!!_insane__!!!!__GME], etc... ]
        for (let thisN = 2; thisN <= all2dGramSequencesWithIndex.length; thisN++) {
            const theseSequenceSets = naturalNGrams.ngrams(all2dGramSequencesWithIndex, thisN);
            theseSequenceSets.forEach((thisSequenceSet) => {
                const allDistances = [];
                const allSequenceStrings = [];
                let lowestSeqIndex = null; // this is the number we use to set the index for this 2dGram (the index of it's first child word sequence)
                let prevSequenceEndIndex = null;
                let this2dGramString = '';
                thisSequenceSet.forEach((thisSequence) => {
                    const thisSequenceIndex = thisSequence[0];
                    const thisSequenceStr = thisSequence[1];
                    if (allSequenceStrings.length && allSequenceStrings[allSequenceStrings.length-1] === thisSequenceStr) return; // Do not allow a word sequence to occur twice sequentially in a 2dGram
                    allSequenceStrings.push(thisSequenceStr);
                    if (prevSequenceEndIndex !== null) allDistances.push(thisSequenceIndex - prevSequenceEndIndex);
                    prevSequenceEndIndex = thisSequenceIndex + thisSequenceStr.length;
                    // distance has now been calculated restore our proper word delimeter
                    if (this2dGramString !== '') this2dGramString = this2dGramString + '__!!!!__';
                    this2dGramString = this2dGramString + thisSequenceStr.replaceAll(' ', '_!!_');
                    if (lowestSeqIndex === null || thisSequenceIndex < lowestSeqIndex) lowestSeqIndex = thisSequenceIndex;
                });
                if (allSequenceStrings.length < 2) return;
                const totalDistance = allDistances.reduce((prev, cur) => prev + cur); // just a sum
                all2dGrams.push({distance: totalDistance, index: lowestSeqIndex, word: this2dGramString});
                all2dGramStrings.push(this2dGramString);
            });
        }
        // console.log('all2dGrams', all2dGrams);

        // Last, create word objects for the 2dGrams that we have extracted, and save to redis. We also create wordRef objects to be saved directly on this comment.
        all2dGrams.forEach((this2dGram) => {
            const newWordAbsKey = wordModel.generateWordObjectKey(this2dGram.word);
            let allRawWords = [];
            let allHasSymbols = [];
            const wordSeqsIn2dGram = this2dGram.word.split('__!!!!__');
            const wordObjValue = []; // for setting newWordObject.value below
            wordSeqsIn2dGram.forEach((thisWordSeqStr) => {
                const matchedWordRef = comment.words.find(thisWord => thisWord.word === thisWordSeqStr);
                if (matchedWordRef) {
                    allRawWords = allRawWords.concat(matchedWordRef.rawWords);
                    allHasSymbols = allHasSymbols.concat(matchedWordRef.hasSymbols);
                }
                wordObjValue.push(thisWordSeqStr.split('_!!_'));
            });
            allRawWords = [...new Set(allRawWords)]; // remove dups
            allHasSymbols = [...new Set(allHasSymbols)];

            // add wordRef to comment
            const wordRefExists = comment.words.find(thisWordRef => thisWordRef.word === this2dGram.word);
            if (!wordRefExists) {
                // console.log(`comment:${comment.id} earned a new 2dGram: ${this2dGram.word}`)
                const newWordRefObject = wordModel.createWordRefObject({
                    type: '2dGram',
                    word: this2dGram.word,
                    rawWords: allRawWords,
                    hasSymbols: allHasSymbols,
                    index: this2dGram.index,
                    distance: this2dGram.distance
                });
                comment.words.push(newWordRefObject);
                // Save this word to it's WordToCommentsIndex (creating one if it does not yet exist)
                wordModel.registerWordToCommentsIndex(this2dGram.word, comment, self.redisClient, (addedCommentToIndex) => { // this needs to be done before the rpush because of topCommentsStats logic
                    if (!addedCommentToIndex) return; // for some reason the comment id was not added to the wordToCommentsIndex. Do not proceed to add word tstamp.
                    wordModel.addFoundAtTstampForWord(newWordAbsKey, comment, self.redisClient);
                });
                // This comment will be saved at the bottom of refreshTopComments BUT ONLY if this comment is deemed a top comment (see reducePendingTopComments). For this reason, because we just altered the comment object, and don't know yet if it's going to become a topComment, we must save now too.
                self.redisClient.set(`comment:${comment.id}`, commentModel.minimizeForDb(comment));
            }

            // add new word object to redis (or merge if exists)
            const newWordObject = wordModel.createWordObject({
                type: '2dGram',
                value: wordObjValue,
                rawWords: allRawWords,
                hasSymbols: allHasSymbols
            });
            // We are not going to wait on this throttled redis action before calling our cback. We want to return asap as to not tie up this process.
            self.redisClient.throttle.get(newWordAbsKey, (existingWordObj) => {
                let saveWordObj = newWordObject;
                if (existingWordObj) {
                    saveWordObj = wordModel.merge(existingWordObj, newWordObject);
                }
                self.redisClient.throttle.set(newWordAbsKey, saveWordObj);
            });
        }); //end all2dGrams.forEach(

        if (cback) cback(all2dGramStrings);
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

    isDiscardComment(comment) {
        // This process includes rules around which comments should be excluded in trend analysis. Ie: comments that are from not relevant users
        let shouldDiscard = false;

        // 1. has the user been marked as not relevant. Comments will be discarded first by the fetchRedditComments process, but consider
        // this a backup to catch any offending comments which may have already been saved to redis (before the not relevant rule was established)
        if (this.trainingNotRelevant) {
            const notRelUserIndex = this.trainingNotRelevant.users.findIndex((thisUser) => thisUser.username === comment.author.name);
            if (notRelUserIndex !== -1) {
                shouldDiscard = true;
                console.warn(`Comment will be discarded because user ${comment.author.name} is now not relevant: ${comment.id}`);
                return shouldDiscard;
            }
            // check for trainingNotRelevant.comments.id
            const notRelCommentIdIndex = this.trainingNotRelevant.comments.findIndex((thisComment) => thisComment.id === comment.id);
            if (notRelCommentIdIndex !== -1) {
                shouldDiscard = true;
                console.warn(`Comment will be discarded because it was individually marked as not relevant: ${comment.id}`);
                return shouldDiscard;
            }
        }

        // 2. HashHype also enforces a rule that no comment should have earned points on every single word combination possible. It was found that when this happens,
        // it was usually because a single user posted an identical comment more than once, was a single word comment with no additional context, or was a comment by bots
        // that posted the same canned comments under different usernames.

        const allTriGramsInComment = comment.words.filter(wordRef => wordRef.type === 'trigram'); // the quickest way to do this is only look at the trigrams. If they all got pointed, the whole comment got pointed.
        // We will only enforce this rule on comments that have at least 3 trigrams (5 tokens). We don't want to be too agressive in removing short comments that validly earn points on all words.
        // i.e: "I love GME" may just be something that many unique users are saying at the same time, not a fishy copy/paste duplicate comment or a canned bot.
        if (allTriGramsInComment.length >= 3) {
            let pointedTrigramCount = 0;
            allTriGramsInComment.forEach((thisTriGram) => {
                if(typeof comment.points['1Hr'][thisTriGram.word] !== 'undefined') ++pointedTrigramCount; // we store point records that were calculated to 0
            });
            if (pointedTrigramCount === allTriGramsInComment.length) {
                shouldDiscard = true;
                console.warn(`Comment will be discarded because all of it's word combos earned points. Suspected dup comment:${comment.id} by user ${comment.author.name}. Comment body: ${comment.body}`);
                return shouldDiscard;
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
                this.topComments.comments.forEach((thisComment) => {
                    if (thisComment.author && thisComment.author.name === notRelevantUser) self.removeCommentFromTopComments(thisComment.id); // (also removes from redis throttle cache)
                });
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
        this.redisClient.get(this.trainingNotRelevantKey, (trainingObj) => {
            if (!trainingObj) {
                // Since this topCommentStats process writes to the redis 'training:notRelevant' object,
                // it should always be locally defined. Instantiate a blank object now.
                self.trainingNotRelevant = trainingModels.createTrainingNotRelevantObject();
                return;
            }
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
        const revisedTopComments = {comments: []};
        this.topComments.comments.forEach((thisComment, thisCommentIndex) => {
            if (thisComment.id !== removeCommentId) {
                revisedTopComments.comments.push(thisComment);
                return;
            }
            console.log(`Removing comment from ${this.topCommentsStatsKey}. Comment: ${removeCommentId}`);
        });
        this.topComments.comments = revisedTopComments.comments;
        this.throttle.storeNewTopCommentsStats();
    }

    getWordToCommentsIndexForTimeRange(wordString, maxAge = 3600000, cback) { // defaults to return only commentIds that are less than 1 hr old
        const self = this;
        const thisIndexKey = `index:wordToComments:${wordString}`;
        const now = Date.now();
        self.redisClient.zrange(thisIndexKey, now - maxAge, now, (commentIdsInRange) => {
            if (cback) cback(commentIdsInRange);
        });
    }

    removeCommentFromWordToCommentIndexes(commentId, associatedWords) {
        const self = this;
        associatedWords.forEach((wordString) => {
            const thisIndexKey = `index:wordToComments:${wordString}`;
            self.redisClient.zrem(thisIndexKey, [commentId], (commentRemovedCount) => {
                if (commentRemovedCount === 0) console.warn(`Could not remove comment:${commentId} from ${thisIndexKey}`);
            });
        });
    }

    removeCommentFromAll(argOpts = {}) {
        const opts = Object.assign({
            comment: undefined,
            commentId: undefined,
            associatedWords: undefined
        }, argOpts);
        if (opts.comment && !opts.associatedWords) {
            opts.associatedWords = opts.comment.words.map(thisWordRef => thisWordRef.word);
        }
        if (opts.comment && !opts.commentId) {
            opts.commentId = opts.comment.id;
        }
        if (opts.commentId) this.removeCommentFromTopComments(opts.commentId);
        if (opts.commentId && opts.associatedWords) this.removeCommentFromWordToCommentIndexes(opts.commentId, opts.associatedWords);
        // In some logic this function may be called for a comment which was not found in redis (returned null). If that was the case, we don't want to attempt to delete right now.
        if (opts.commentId && opts.comment !== null) this.redisClient.del(`comment:${opts.commentId}`);
    }

    newTimeBucketObject(bucketType = 'objects') {
        // Isolating this to ensure time key naming is consistent. bucketType can be 'objects', 'arrays', 'integers'
        let timeBucketObject = {
            '1Hr': {},
            '12Hr': {},
            '24Hr': {},
        };
        if (bucketType === 'integers'){
            timeBucketObject = {
                '1Hr': 0,
                '12Hr': 0,
                '24Hr': 0,
            };
        } else if (bucketType === 'arrays') {
            timeBucketObject = {
                '1Hr': [],
                '12Hr': [],
                '24Hr': [],
            };
        }
        return timeBucketObject
    }

    newTopCommentsEntity(initial = {}) {
        // returns an initial state for a top comment stats
        return {
            absKey: this.topCommentsStatsKey,
            comments: [],
            ui: {
                viewPath: '/ui/views/topCommentStats.jsx.js'
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
            self.redisClient.set(self.topCommentsStatsKey, self.topComments, () => {
                self.storeNewTopCommentsStatsIsPending = false;
                clearTimeout(self.storeNewTopCommentsStatsIsPendingTimeout);
                self.storeNewTopCommentsStatsIsPendingTimeout = null;
                console.log('Updated stats:topComments at time:', Date.now());
            });
        });
    }

    persistProcessState(cback) {
        // This function will take certain process class properties (defined in constructor) and persist them to redis.
        // The properties to be saved are the ones which need to be restored when the process is restarted.
        const self = this;

        // 1. Restore process state from redis
        if (!self.persistedState) {
            self.redisClient.get(self.processPersistKey, (processStateObj) => {
                self.persistedState = Object.assign({
                    topWordsCounts: self.topWordsCounts || {},
                    topWordsMinCount: self.topWordsMinCount || 0
                }, processStateObj);

                self.topWordsCounts = self.persistedState.topWordsCounts;
                self.topWordsMinCount = self.persistedState.topWordsMinCount;

                console.log(`Restored process state ${self.processPersistKey}`); //:`, self.persistedState);
                self.persistProcessState(cback);
            });
            return;
        }

        // 2. Save process state to redis
        self.persistedState.topWordsCounts = self.topWordsCounts;
        self.persistedState.topWordsMinCount = self.topWordsMinCount;
        self.redisClient.set(self.processPersistKey, self.persistedState, () => {
            console.log(`Saved process state ${self.processPersistKey}`); //:`, self.persistedState);
            if (cback) cback();
        });

        // 3. Init interval to resave process state to redis
        if (self.processPersistInterval) return;
        self.processPersistInterval = setInterval(() => {
            self.persistProcessState();
        }, self.processPersistIntervalTime);
    }

    logInspectTopComments() { // util for debugging
        const summTopComments = [];
        this.topComments.comments.forEach((thisTopComment) => {
            const thisSumm = {
                id: thisTopComment.id,
                body: thisTopComment.body,
                points: thisTopComment.points,
                totalPoints: thisTopComment.totalPoints,
                topSymbols: thisTopComment.topSymbols
            };
            summTopComments.push(thisSumm);
        })
        console.log(util.inspect(summTopComments, {depth: 5, colors: true}));
    }

}

const thisCommentsStats = new TopCommentsStats();
export default TopCommentsStats;
