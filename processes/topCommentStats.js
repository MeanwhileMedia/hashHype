import util from 'util';
import { throttle } from 'throttle-debounce';
import yargs from 'yargs';
import natural from 'natural';
import { std, median, sum } from 'mathjs';
import RedisClient from '../utils/redisClient.js';
import commentModel from '../utils/objectModels/comment.js';
import wordModel from '../utils/objectModels/word.js';
import symbolModel from '../utils/objectModels/symbol.js';
import trainingModels from '../utils/objectModels/training.js';
import stopWords from '../utils/stopWords.js';

const argv = yargs(process.argv.slice(2)).argv;

const naturalNGrams = natural.NGrams; // is object (naturalNGrams.ngrams(string or array)) - Can runs through a tokenizer when passed a string.

class TopCommentsStats {
    constructor() {
        const self = this;
        this.topCommentsStatsKey = 'stats:topComments'; // The resulting computed data produced by this process
        this.topCommentsStatsFullKey = 'stats:topComments:full'; // This is a variation of stats:topComments which holds full comment objects. It is massive, and is only used by this process (fetched from redis once at process start)
        this.topTrendsStatsKey = 'stats:topTrends';
        this.trainingNotRelevantKey = 'training:notRelevant';

        this.topComments = this.newTopCommentsEntity({absKey: this.topCommentsStatsFullKey});

        this.pendingCommentIdsToWords = {}; // these id's are roughly estimated to become topComments. Confirmed during refreshTopComments. {commentId1: ['word_!!_234', 'word_!!_foo'], etc}
        this.pendingWordFoundAtKeyspaceChannels = {}; // a local record of which '__keyspace@0__:word:*:foundAt' channels have already emitted messages during this refreshTopComments interval. No channel will be acted on twice during one interval.
        this.trackCommentsFor = 3600000; // ms (1hr) How long will we keep updating redis comment objects with recurring word points

        this.topWordsCounts = []; // [['foo_bar', 35], [baz, 100], etc...] // caches counts for words found to be both top, or not.
        this.topWordsCountsIndex = {} //  {foo_bar: indexOfCountWithinTopWordsCounts, baz: 101, etc...} - this object just helps our lookup into topWordsCounts which is an ordered array
        this.topWordsCountsMaxLength = 100000; // should be a multiple of 10
        this.topWordsMinCount = 100; // Will start high at process init. Better to slowly adjust down than have an immidate memory overflow (cuz of trying to process too many comments based on too many word occurances)
        this.topWordsRefreshInterval = null;
        this.topWordsRefreshIntervalTime = 10000;
        this.lastIntervalTotalWordsCount = 0; // total new words that we reported via pubsub '__keyspace@0__:word:*:foundAt' in the last ${topWordsRefreshIntervalTime}ms
        this.lastIntervalTopWordsCount = 0; // How many words were deemed top words in the last ${topWordsRefreshIntervalTime}ms? for logging/debugging the impact of our "isTopWord" logic.
        this.lastIntervalTopWordsCached = 0; // how many isTopWord lookups had cached values in topWordsCounts
        this.minAvgPercentTopWords = 20; // If the rolling average of percent of words which are deemed top words falls below this number, topWordsMinCount will be adjust down in increments until we start hitting our min percent.
        this.groupSizeForAvgPercentTopWords = 5; // We will store the percentage of words which were topWords for this many topWordsRefreshIntervals. After, the averaged percentage becomes part of the logic to update topWordsMinCount.

        this.topCommentsMustHaveSymbol = true; // set to true and highly pointed comments that do NOT have a symbol will be excluded from topComments (though they will still be pointed for their reocurring words).
        this.topCommentsMustHaveSymbolTypes = ['stock', 'coin'];
        this.minTopCommentsPerSymbolType = 20; // How many top comments should be gathered BEFORE they are run through applyTopCommentsTrendHistory

        this.minTokenClusterLengthFor2dGram = 4; // this must always be greater than our longest word type (trigrams) otherwise we will have key conflicts in redis over the 2dGram vs trigram version of it.
        this.maxTokenClusterLengthFor2dGram = 10; // If we don't set a max then some comments which managed to have a high number of pointed tokens could overflow memory while 2dGram logic below tries to compute tens of thousands of combinations. We must assume that a comment with this many pointed words has diluted any potential for useful 2dGrams.

        this.storeNewTopCommentsStatsThrottleTime = 5000;
        this.throttle = {
            storeNewTopCommentsStats: throttle(this.storeNewTopCommentsStatsThrottleTime, this.storeNewTopCommentsStats).bind(this),
        };
        this.maxCommentsPerTopCommentsRefresh = null; // To ensure hardware stability, topCommentStats will only process this max number of comments for each loop of storeNewTopCommentsStats. Defaults null (no max) but will be later be adjusted up/down set in setMaxCommentsPerTopCommentsRefresh.
        this.commentsCountForLastTopCommentsRefresh = null; // used to track and dynamically set maxCommentsPerTopCommentsRefresh when we have overlapping calls to storeNewTopCommentsStats
        this.maxCommentsPerTopCommentsRefreshResetTimeout = null; // The maxCommentsPerTopCommentsRefresh is manually reset to null after a timeout so that it can be recalculated under current load.
        this.maxCommentsPerTopCommentsRefreshResetTimeoutLength = 60000*10; // every 10 minutes AFTER there were no storeNewTopCommentsStats overlaps
        this.onlyDiscardOverflowCommentsFromSources = ['twitter_sampleStream']; // when our hardware lags and is set, refreshTopComments discards random comments. Set onlyDiscardOverflowCommentsFromSources to ensure the discarded comments must have a specific comment.source, like "twitter_sampleStream". Set to empty array and all sources are eligible to be discarded.
        this.quotedCommentsAreNeverTopComments = true; // set to true and any time comment.isQuoted == true it will not be considered for topComment, and will not generate 2dGrams. These comments do still go through extractWordsFromComments though, so their words generate foundAt tstamps.
        this.quotedCommentsDiscardCount = 0; // for logging

        this.topCommentsWithPointed2dGramLastRefresh = {}; // for logging 2dGram activity {commentId: int, etc} (where int is the number of 2dGrams on that comment that earned points, even if 0 points)

        console.log('A new topCommentStats process has just started...');
        this.redisClient = null;
        self.initRedisClient(() => {
            self.redisClient.get(self.topCommentsStatsFullKey, (topCommentStatsObj) => {
                if (topCommentStatsObj) self.topComments = topCommentStatsObj;
                self.initKeyspaceSubscriptions();
                self.syncTrainingNotRelevant();
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        this.redisClient = new RedisClient({
            onConnect: (client) => {
                console.log('Connected to locally hosted redis DBs for topCommentStats class.');
                if(cback) cback();
            }
        });
    }

    initKeyspaceSubscriptions() {
        const self = this;
        this.redisClient.on('pmessage', function (matchedPattern, patternWithKey, action){ // If this event was sent as part of the set pattern subcribed keyspace event, then it's "patternWithKey" will be: __keyspace@0__:word:foo_!!_bar:foundAt
            if (action !== 'zadd') return;

            // We will only run isTopWord and getWordToCommentsIndexForTimeRange once per word per storeNewTopCommentsStats interval (to save on mem/cpu).
            if (self.pendingWordFoundAtKeyspaceChannels[patternWithKey]) return; // remember that self.pendingWordFoundAtKeyspaceChannels gets reset inside storeNewTopCommentsStats().
            self.pendingWordFoundAtKeyspaceChannels[patternWithKey] = 1;
            ++self.lastIntervalTotalWordsCount;

            const wordString = patternWithKey.replace(/__keyspace@0__:word:|:foundAt/g, '');
            self.isTopWord(wordString, (isTopWord) => {
                if (!isTopWord) return;
                ++self.lastIntervalTopWordsCount;
                // Get all comments, less than 1hr old, which contain this word. For realtime point calculation, we only access new comments (to save on CPU).
                self.getWordToCommentsIndexForTimeRange(wordString, self.trackCommentsFor, (wordToCommentsIndex) => {
                    if (!wordToCommentsIndex) return;
                    wordToCommentsIndex.forEach((thisCommentId) => {
                        self.pendingCommentIdsToWords[thisCommentId] = self.pendingCommentIdsToWords[thisCommentId] || [];
                        self.pendingCommentIdsToWords[thisCommentId].push(wordString); // We don't check for dups right now to save on cpu.
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
        const thisTopWordCount = self.topWordsCounts[self.topWordsCountsIndex[wordString]];
        if (thisTopWordCount) {
            ++self.lastIntervalTopWordsCached;
            // console.log(wordString, ' topWordsCounts was cached');
            if (thisTopWordCount[1] >= self.topWordsMinCount) {
                if (cback) cback(true);
            } else {
                if (cback) cback(false);
            }
            return;
        } else {
            // console.log(wordString, ' topWordsCounts was not cached');
        }

        // HashHype rule - a foundAt occurance for a 2dGram will ALWAYS trigger a point recalculation for all comments which share it.
        // This is because 2dGrams have high value, but often low foundAt counts. We want to make sure the comments which hold this 2dGram
        // are given the chance to become a topComment even if they aren't being called up for one of their other words.
        if (wordString.split('_!!_').length >= this.minTokenClusterLengthFor2dGram) {
            // console.warn(`2dGrams are always topWords (${wordString})`)
            if (cback) cback(true);
            return;
        }

        // This incoming word was not yet cached to this.topWordCounts. Fetch the "foundAt" redis list length now.
        const wordFoundAtKey = `word:${wordString}:foundAt`;
        self.redisClient.zcard(wordFoundAtKey, (thisFoundAtListLength) => {
            // Here is where we maintain a max length of our self.topWordsCounts record
            if (self.topWordsCounts.length >= self.topWordsCountsMaxLength) {
                const expiredTopWordsCounts = self.topWordsCounts.splice(0, self.topWordsCountsMaxLength*0.1); // delete the oldest stored values first. Do so in batches of 10% so we don't end up splicing in every single loop.
                expiredTopWordsCounts.forEach((thisTopWordCount) => {
                    delete self.topWordsCountsIndex[thisTopWordCount[0]];
                });
            }

            const thisCountIndex = self.topWordsCounts.push([wordString, thisFoundAtListLength]) - 1;
            self.topWordsCountsIndex[wordString] = thisCountIndex;
            //self.topWordsCounts[wordString] = thisFoundAtListLength;

            if (thisFoundAtListLength >= self.topWordsMinCount) {
                if (cback) cback(true);
            } else {
                if (cback) cback(false);
            }
        });

        // Set an interval to take care of dups and re-fetch the foundAt list lengths for all words which already exist on this.topWords
        if(self.topWordsRefreshInterval) return;
        self.topWordsRefreshInterval = setInterval(() => {
            // First we will update self.topWordsMinCount via self.setTopWordsMinCount(). The new value is used below as we trim self.topWordsCounts.
            self.setTopWordsMinCount();

            // Now loop through topWordsCounts and only keep the words which did NOT meet the topWordsMinCount. They are the ones that need to be recounted next time they occur.
            const newTopWordsCounts = [];
            const newTopWordsCountsIndex = {};
            self.topWordsCounts.forEach((thisTopWordCount) => {
                if (thisTopWordCount[1] >= self.topWordsMinCount) { // we know that this word has already pased our min count and won't likely dip below in the immediate future. Keep it's cached record.
                    const newIndex = newTopWordsCounts.push(thisTopWordCount) + 1;
                    newTopWordsCountsIndex[thisTopWordCount[0]] = newIndex;
                } else if (thisTopWordCount[1] < self.topWordsMinCount * 0.5) { // we know that this word was well below our min count and won't likely jump above it in the immediate future. Keep it's cached record.
                    const newIndex = newTopWordsCounts.push(thisTopWordCount) + 1;
                    newTopWordsCountsIndex[thisTopWordCount[0]] = newIndex;
                }
            });
            self.topWordsCounts = newTopWordsCounts;
            self.topWordsCountsIndex = newTopWordsCountsIndex;
        }, self.topWordsRefreshIntervalTime);
    }

    setTopWordsMinCount() {
        const self = this;

        // First calc/log the percent of words which were deemed top words in the last topWordsRefreshInterval
        const percentTopWords = Math.floor((self.lastIntervalTopWordsCount / self.lastIntervalTotalWordsCount) * 100);
        console.log(`Current topWordsMinCount: ${self.topWordsMinCount}`);
        console.log(`Total top words in last ${self.topWordsRefreshIntervalTime/1000} seconds: ${self.lastIntervalTopWordsCount}/${self.lastIntervalTotalWordsCount} (${percentTopWords}%)`);
        const percentCachedTopWordCounts = Math.floor((self.lastIntervalTopWordsCached / self.lastIntervalTotalWordsCount) * 100);
        console.log(`Currently cached foundAt counts for ${self.topWordsCounts.length} words. ${self.lastIntervalTopWordsCached}/${self.lastIntervalTotalWordsCount} (${percentCachedTopWordCounts}%) isTopWord lookups returned cached values in the last ${self.topWordsRefreshIntervalTime/1000} seconds.`);
        self.lastIntervalTotalWordsCount = 0; // reset counters now
        self.lastIntervalTopWordsCount = 0;
        self.lastIntervalTopWordsCached = 0;
        self.pendingWordFoundAtKeyspaceChannels = {};

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
        }

        self.topWordsMinCount = adjustedTopWordsMinCount;
        self.pendingTopWordsPercentsForAvg = []; // reset our group for calculating the rolling average
    }

    refreshTopComments(lastTopCommentsStats, cback) {
        const self = this;
        let freshTopCommentsStats;

        // During the keyspace listener loop (for when any word gets a tstamp added to it's "foundAt" redis list) a very rough estimate is made for
        // which comments MIGHT become topComments. Those comment id's are added to "this.pendingCommentIdsToWords". This refreshTopComments function
        // then runs the full logic (in intervals) to apply points for every word in the comment and compares to all other pendingCommentIdsToWords AND existing
        // this.topComments to see which ones will be finalized into this.topComments and prepped for rendering.

        const pendingCommentIdsToWords = self.pendingCommentIdsToWords;
        self.pendingCommentIdsToWords = {};

        // To ensure hardware stability, topCommentStats will only process a max number of comments for each loop of refreshTopComments (if self.maxCommentsPerTopCommentsRefresh is not null).
        // We will not discard any current this.topComments.comments within this trimming logic. They must all be repointed every time.
        const pendingCommentIds = Object.keys(pendingCommentIdsToWords);
        const existingTopCommentIds = Object.values(lastTopCommentsStats.comments).flat().map((thisCom) => thisCom.id);

        let discardCommentIds =  [];
        if (self.maxCommentsPerTopCommentsRefresh && pendingCommentIds.length > self.maxCommentsPerTopCommentsRefresh) {
            // discard the oldest comments within pendingCommentIds. Because these comments have not yet been sorted, this is a close approximation of a random sample.
            // Note that there may be fewer comments removed than this number (because we never remove an existing topComment, and it's ID may be wrongly chosen here)
            const removeCommentCount = pendingCommentIds.length - self.maxCommentsPerTopCommentsRefresh;
            discardCommentIds = pendingCommentIds.slice(0, removeCommentCount);
        }

        // We have recorded all relevant words and comments that need to be a part of this pointing refresh, but it was fast and dirty
        // with no checks for dups. We wait until now to resolve dup words and comments as to not bog down CPU before the refreshTopComments interval.
        for (const [commentId, wordStrings] of Object.entries(pendingCommentIdsToWords)) {
            pendingCommentIdsToWords[commentId] = [...new Set(wordStrings)];
        };

        // Proceed to comment get promises, then point counting promises. After they all complete we can save the newly calculated self.topComments to redis.
        const checkAndRestoreComment = (comment, commentId, resolve) => {
            if (!comment) {
                // if this comment couldn't be found in redis, then delete from top comment stats (may have beed deleted by training or redis LRU algo)
                // console.log(`Missing comment in redis: ${commentId}`);
                self.removeCommentFromAll({commentId: commentId, associatedWords: pendingCommentIdsToWords[commentId]}, () => {
                    delete pendingCommentIdsToWords[commentId];
                    resolve(null);
                });
                return;
            }
            if (self.isDiscardComment(comment)) {
                self.removeCommentFromAll({comment: comment}, () => {
                    delete pendingCommentIdsToWords[commentId];
                    resolve(null);
                });
                return;
            }

            resolve(commentModel.ensureCommentObjectDefaults(comment));
        }; // end checkAndRestoreComment

        // When forming possibleTopComments (allCommentGetPromises), we will include all comments which contain a recently commented topWord,
        // AND we must be sure to add all current topComments (self.topComments.comments). They will all compete against eachother during pointing to be new topComments.
        let totalCommentsDiscarded = 0;

        // const getAllCommentIds = pendingCommentIds.concat(existingTopCommentIds);
        const getAllCommentIds = pendingCommentIds.filter((thisId) => existingTopCommentIds.indexOf(thisId) === -1);
        const getAllCommentKeys = getAllCommentIds.map((thisId) => `comment:${thisId}`);
        if (!getAllCommentKeys.length) {
            console.warn(`There were 0 new comments during this refreshTopComments interval.`);
            if (cback) cback(lastTopCommentsStats); // final cback to refreshTopComments. Since we didn't have any new comments, just return the previous topCommentStats
            return;
        }

        console.log(`Will now mget ${getAllCommentKeys.length} new comments from redis...`);
        self.redisClient.mget(getAllCommentKeys, (allNewComments) => { // remember that mget does NOT use dynamic db logic, but that's ok for comments because they are only ever written to short.

            // Now combine all the new comments we just got from redis, and our existing topComments which are held in local memory at self.topComments (lastTopCommentsStats)
            const allCommentGetPromises = [];
            allNewComments.forEach((thisNewComment, thisNewCommentIndex) => {
                const thisNewCommentId = getAllCommentIds[thisNewCommentIndex];
                allCommentGetPromises.push(new Promise((resolve, reject) => {
                    const discardIt = () => {
                        self.removeCommentFromAll({comment: thisNewComment}, () => {
                            delete pendingCommentIdsToWords[thisNewComment.id];
                            ++totalCommentsDiscarded;
                            resolve(null);
                        });
                    }
                    if (thisNewComment && discardCommentIds.indexOf(thisNewComment.id) !== -1) { // we must send the full comment object to removeCommentFromAll or it won't be cleared from it's associated wordToComment indexes.
                        if (self.onlyDiscardOverflowCommentsFromSources.length) {
                            if (self.onlyDiscardOverflowCommentsFromSources.indexOf(thisNewComment.source) !== -1) {
                                discardIt();
                                return;
                            }
                        } else {
                            discardIt();
                            return;
                        }
                    }
                    checkAndRestoreComment(thisNewComment, thisNewCommentId, resolve);
                }));
            });
            Object.values(lastTopCommentsStats.comments).flat().forEach((thisExistingComment) => {
                allCommentGetPromises.push(new Promise((resolve, reject) => {
                    checkAndRestoreComment(thisExistingComment, thisExistingComment.id, resolve);
                }));
            });

            Promise.all(allCommentGetPromises).then((allComments) => {
                const possibleTopComments = allComments.filter(Boolean); //remove null responses (was redis 404, or was discarded, etc)
                self.commentsCountForLastTopCommentsRefresh = possibleTopComments.length;
                if (totalCommentsDiscarded) console.warn(`${totalCommentsDiscarded} random comments were discarded because the number of comments in this call to refreshTopComments exceeded our max of ${self.maxCommentsPerTopCommentsRefresh}`);
                console.log(`Will now select ${self.minTopCommentsPerSymbolType * self.topCommentsMustHaveSymbolTypes.length} topComments from ${self.commentsCountForLastTopCommentsRefresh} comments...`);

                const allCommentPointingPromises = [];
                possibleTopComments.forEach((comment) => {
                    // Before calculating points for this word, we will extract 2dGrams and store them as new word objects in redis. We do this before pointing so we can
                    // determine if this word is about to earn points on this comment for the first time (see extractNew2dGramsFromTopComment for more).
                    if (!pendingCommentIdsToWords[comment.id]) {
                        return; // this is likely an existing comment transferred to possibleTopComments from self.topComments.comments (which did not have any recently commented words this round)
                    }
                    allCommentPointingPromises.push(new Promise( (resolve, reject) => {
                        self.extractNew2dGramsFromTopComment(pendingCommentIdsToWords[comment.id], comment, (allNew2dGramStrings) => {
                            allNew2dGramStrings.forEach((this2dGramString) => {
                                if (pendingCommentIdsToWords[comment.id].indexOf(this2dGramString) === -1) {
                                    // looks like the above extractNew2dGramsFromTopComment found a new 2dGram for this comment. Let's add it to our local record objects before proceeding.
                                    pendingCommentIdsToWords[comment.id].push(this2dGramString);
                                }
                            });
                            pendingCommentIdsToWords[comment.id].forEach((thisPendingWordStr) => {
                                // first we must collect all comments which are getting points re-counted for this specific word re-occurance. This list
                                // is used by applyPointsToCommentForWord to deduct points for word re-uses by the same comment author.
                                // Now we can proceed to add up comment.points for this word, and later determine if this comment is a topComment.
                                self.applyPointsToCommentForWord(comment, comment.words[thisPendingWordStr], () => {
                                    resolve();
                                });
                            });
                        }); // end extractNew2dGramsFromTopComment
                    })); // end allCommentPointingPromises.push(new Promise
                }); // end possibleTopComments.forEach


                Promise.all(allCommentPointingPromises).then(() => {
                    // Now take another look at each comment to see if it belongs in our topComments object
                    const finalPossibleTopComments = [];
                    const allDiscardAfterPointingPromises = [];
                    possibleTopComments.forEach((comment) => {
                        if (self.isDiscardComment(comment)) { // we are gonna run every comment through isDiscardComment one last time (now that the comments were pointed).
                            allDiscardAfterPointingPromises.push(new Promise( (resolve, reject) => {
                                self.removeCommentFromAll({comment: comment}, () => {
                                    resolve();
                                });
                            }));
                            return;
                        }
                        finalPossibleTopComments.push(comment);
                    });

                    Promise.all(allDiscardAfterPointingPromises).then(() => {

                        // Now sort all "finalPossibleTopComments" into pendingTopComments, then move the winners from pendingTopComments to self.topComments.comments.
                        self.pendingTopComments = {};  // { 'symbol:stock:GME': [comment1, comment3], 'symbol:stock:YOLO': [comment2, comment3, etc...]} }
                        self.groupPendingTopCommentsByTopSymbols(finalPossibleTopComments); // assigns all finalPossibleTopComments as deep clones to self.pendingTopComments
                        self.calcTotalPointsForPendingTopComments(); // loops self.pendingTopComments and alters comments in place - assigns comment.totalPoints
                        freshTopCommentsStats = self.reducePendingTopComments(); // Chooses the final top comments that were valid and score the highest within their symbol group. This is when a subset of pendingTopComments is returned to finally set freshTopCommentsStats.

                        // Now we will further reduce topComments.comments by passing them through historical data logic
                        self.applyTopCommentsTrendHistory(freshTopCommentsStats, () => {
                            // Now take a final pass at self.pendingTopComments and save to redis. We will also do any necc. cleanup/additions to each topComment to prep for rendering.
                            const allTopCommentCleanupPromises = [];

                            const msetCmd = [];
                            const saveTheseComments = Object.values(freshTopCommentsStats.comments).flat();
                            saveTheseComments.forEach((thisComment) => {
                                msetCmd.push( `comment:${thisComment.id}`, JSON.stringify(commentModel.minimizeForDb(thisComment)) );
                                allTopCommentCleanupPromises.push(new Promise( (resolve, reject) => {
                                    // commentModel.minimizeForClient(thisComment, true); // passing true to alter thisComment in-place
                                    if (thisComment.symbols && thisComment.symbols.length) {
                                        resolve(); // looks like this comment already has it's symbols attached. Was likely an existing topComment that was held in local memory. No need to refetch as symbol objects rarely change.
                                        return;
                                    }
                                    self.addSymbolsDataToComment(thisComment, () => { // To properly render this comment in the topCommentStats UI, we need to populate it's comment.symbols array.
                                        resolve();
                                    });
                                }));
                            });

                            // We will now perform a very large mset with all our updated comment data. However, we will NOT wait for this to return before we continue with the next refreshTopComments loop.
                            // We can do this because any comments being saved here are topComments. TopComments are held in local memory and we don't redis get them during our next loop. The only comments we
                            // get are new incoming comments that have not yet competed for topComment. Those new comments are saved to DB by extractWordsFromComments.
                            if (msetCmd.length) {
                                const startTime = Date.now();
                                // console.log(`Now saving (mset) ${saveTheseComments.length} updated topComments to DB. Started ${startTime}...`);
                                self.redisClient.mset(msetCmd, () => { // remember that mset does NOT use dynamic db logic, but that's ok for comments because they are only ever written to short.
                                    console.log(`Finished saving ${saveTheseComments.length} updated topComments to DB. Started ${startTime}. Duration: ${(Date.now() - startTime) / 1000} seconds.`);
                                });
                            } else {
                                console.warn(`There were 0 topComments selected by refreshTopComments.`);
                            }

                            allTopCommentCleanupPromises.push(new Promise( (resolve, reject) => {
                                self.deleteLoserComments(freshTopCommentsStats, () => { // Every comment that was pointed and compared and DID NOT earn a place as topComment will be fully deleted from Redis right now.
                                    self.pendingTopComments = {}; // pendingTopComments has been looped over and the comments that were chosen were moved to self.topComments.comments. Reset pendingTopComments so can be cleared from memory.
                                    resolve();
                                });
                            }));

                            Promise.all(allTopCommentCleanupPromises).then(() => {
                                if (cback) cback(freshTopCommentsStats); // final cback to refreshTopComments
                            });
                        }); // end applyTopCommentsTrendHistory

                    }); // end Promise.all(allDiscardAfterPointingPromises)
                }); // end Promise.all(allCommentPointingPromises)
            }); // end Promise.all(allCommentGetPromises)
        }); // end self.redisClient.mget(getAllCommentKeys

    } // end refreshTopComments

    applyPointsToCommentForWord(comment, wordRef, cback) { // alters comment in-place (updates points object)
        const self = this;

        const points = wordModel.getWordPointCount(wordRef, comment);
        if (wordRef.type === '2dGram' && points) {
            // console.log(`A 2dGram on comment:${comment.id} just earned ${points} points:`, wordRef.word);
            self.topCommentsWithPointed2dGramLastRefresh[comment.id] = self.topCommentsWithPointed2dGramLastRefresh[comment.id] || 0;
            ++self.topCommentsWithPointed2dGramLastRefresh[comment.id];
        }

        // re-fetch from redis all of the foundAt tstamps for this word, and assign them to comment.points[timebucket][wordString] = totalWordPointsForThisTimebucket (int)
        self.timeBucketWordPointsForComment(comment, wordRef, points, () => {
            if (cback) cback();
        });
    }

    timeBucketWordPointsForComment(comment, wordRef, points, cback) { // alters comment in-place (updates comment.points)
        const self = this;

        //////////
        // Get every single timestamp for when this word was in any comment, then sort sort them into timebuckets and total the points
        const foundAtListKey = `word:${wordRef.word}:foundAt`;
        const now = Date.now();
        const msInHr = 3600000;
        const msIn12Hr = 43200000;
        const msIn24Hr = 86400000;
        self.redisClient.zrange(foundAtListKey, now - msIn24Hr, now, (allFoundAtTstamps) => {
            if (!allFoundAtTstamps || !allFoundAtTstamps.length) {
                if (cback) cback();
                return;
            }
            // console.log(`Now running timeBucketWordPointsForComment for word: ${wordRef.word} and comment: ${comment.id}`)

            // Converts an ordered array of word foundAt tstamps into time bucketed points. Where "foo_bar" is word:  {1hr: {foo_bar: 234}, 12hr: etc...}
            // It then takes this timebucketed points object and merges into comment.points (overwriting any previous point counts for this word)
            const thisWordPoints = self.newTimeBucketObject();
            const thisWordPointsRecord = self.newTimeBucketObject();
            allFoundAtTstamps.forEach((thisFoundAtTstamp) => {
                thisFoundAtTstamp = parseInt(thisFoundAtTstamp); // remember that thisFoundAtTstamp is actually a string

                ////////
                // hashHype rule - a comment can't earn points for containing it's own words.
                if (comment.foundAt === thisFoundAtTstamp) {
                    // console.warn(`comment:${comment.id} can't earn points for itself (word:${wordRef.word})`);
                    return;
                }

                // Proceed with timbucketing the points earned for this word foundAt occurance
                const recordPointsForWord = (timebucketKey) => {
                    thisWordPoints[timebucketKey][wordRef.word] = thisWordPoints[timebucketKey][wordRef.word] || 0;
                    thisWordPoints[timebucketKey][wordRef.word] = thisWordPoints[timebucketKey][wordRef.word] + points;

                    thisWordPointsRecord[timebucketKey][wordRef.word] = thisWordPointsRecord[timebucketKey][wordRef.word] || [];
                    thisWordPointsRecord[timebucketKey][wordRef.word].push(thisFoundAtTstamp);
                }
                if(now - msInHr < thisFoundAtTstamp) {
                    recordPointsForWord('1Hr');
                }
                if(now - msIn12Hr < thisFoundAtTstamp) {
                    recordPointsForWord('12Hr');
                }
                if(now - msIn24Hr < thisFoundAtTstamp) {
                    recordPointsForWord('24Hr');
                }
            });

            // Now transfer into comment.points (which will be stored to redis inside comment object)
            // comment.pointsRecords = comment.pointsRecords || self.newTimeBucketObject();
            for (const [pointsTimeBucketKey, allWordPointCountsForTimeBucket] of Object.entries(comment.points)) {
                if (typeof thisWordPoints[pointsTimeBucketKey][wordRef.word] === 'undefined') { // we store point records that were calculated to 0
                    delete comment.points[pointsTimeBucketKey][wordRef.word]; // clear out old points
                } else {
                    comment.points[pointsTimeBucketKey][wordRef.word] = thisWordPoints[pointsTimeBucketKey][wordRef.word];

                    /////////
                    // hashHype rule - a comment (x) can only earn points for a word at a maximum of once per ms. To enforce this, we store a temporary record called comment.pointsRecords.
                    // It is utilized later in calcTotalPointsForPendingTopComments. See there for more docs.
                    comment.pointsRecords[pointsTimeBucketKey][wordRef.word] = thisWordPointsRecord[pointsTimeBucketKey][wordRef.word];
                }
            };
            if (cback) cback();
        }); // end lrange cback
    }

    groupPendingTopCommentsByTopSymbols(possibleTopComments) {
        const self = this;
        // self.pendingTopComments is a temporary object populated during a batch of calls to isTopComment. Is used to group all potential top comments
        // into symbol buckets so our function can then select just X number of comments for each symbol when transferring this.pendingTopComments to this.topComments
        self.pendingTopComments = {}; // reset for this batch of incoming topComments. Will be boiled down and transferred to this.topComments after this batch is complete.

        possibleTopComments.forEach((comment) => {
            const pointedStartingSymbols = Object.keys(comment.symbolStartPoints);
            if (!pointedStartingSymbols.length) {
                self.pendingTopComments['noSymbols'] = self.pendingTopComments['noSymbols'] || [];
                self.pendingTopComments['noSymbols'].push(comment);
                return;
            }
            self.topCommentsMustHaveSymbolTypes.forEach((mustHaveThisSymbolType) => {
                // At this point, we make a deep clone of the comment and start a variation that only represents it within the context of thisSymbolKey. We do this because when a comment
                // has multiple symbols, it needs to compete for topComment within each symbol group it belongs to.
                // I.e: consider comment: "I love stocks. $GME is better than coins like $SOL. https://t.co/sdf @potus #yolo"
                // This comment needs to compete for topComment with topComments.comments.stock, topComments.comments.coin, and topComments.comments.mention, etc..
                // In order to do so, it's points need to be counted differently within each symbol type group. That's why we clone it now, then calcTotalPointsForPendingTopComments points each one seperately based on which symbol group it's in.
                let commentClone;
                // Since calcTotalPointsForPendingTopComments only counts symbol points for topSymbolHigh and topSymbolLow, we will set them on this commentClone according to it's symbol type group.
                let highSymbol = {symbolKey: '', count: null};
                let lowSymbol = {symbolKey: '', count: null};
                for (let [thisStartSymbolKey, thisStartSymbolPoints] of Object.entries(comment.symbolStartPoints)) {
                    const thisStartSymbolType = thisStartSymbolKey.split(':')[1];
                    if (thisStartSymbolType !== mustHaveThisSymbolType) continue;

                    if (highSymbol.count === null || highSymbol.count < thisStartSymbolPoints) {
                        highSymbol = {symbolKey: thisStartSymbolKey, count: thisStartSymbolPoints};
                    }
                    if (lowSymbol.count === null || lowSymbol.count > thisStartSymbolPoints) {
                        lowSymbol = {symbolKey: thisStartSymbolKey, count: thisStartSymbolPoints};
                    }
                };
                if (lowSymbol.symbolKey === highSymbol.symbolKey) lowSymbol = {symbolKey: '', count: null};
                if (highSymbol.count !== null) {
                    // commentClone = JSON.parse(JSON.stringify(comment));
                    commentClone = commentModel.cloneCommentForNewSymbolGroup(comment);
                    commentClone.topSymbolHigh['1Hr'] = highSymbol.symbolKey
                }
                if (lowSymbol.count !== null) {
                    commentClone.topSymbolLow['1Hr'] = lowSymbol.symbolKey
                }

                if (commentClone) {
                    self.pendingTopComments[commentClone.topSymbolHigh['1Hr']] = self.pendingTopComments[commentClone.topSymbolHigh['1Hr']] || [];
                    self.pendingTopComments[commentClone.topSymbolHigh['1Hr']].push(commentClone);
                }
            });
        });
    } // end groupPendingTopCommentsByTopSymbols

    // calcTotalPointsForPendingTopComments(pendingTopComments) {
    calcTotalPointsForPendingTopComments() {
        const self = this;
        // Sum total points for this comment into timebuckets
        Object.values(self.pendingTopComments).flat().forEach((thisComment) => {

            const correctedCommentPoints = self.newTimeBucketObject()
            for (const [timeBucketKey, pointsByWord] of Object.entries(correctedCommentPoints)) {
                correctedCommentPoints[timeBucketKey] = {...thisComment.points[timeBucketKey]};

                for (const [thisWordStr, pointsForThisWord] of Object.entries(thisComment.points[timeBucketKey])) {
                    if (!pointsForThisWord) continue;
                    const thisWordRef = thisComment.words[thisWordStr];

                    /////////
                    // 1. HashHype rule - A comment can only earn symbol points based on it's topSymbolHigh and topSymbolLow. However, this does not mean that all points for
                    // other symbols are totally discarded. Instead, we enforce max points per symbol to be == points earned for topSymbolHigh / 2 / total symbols. This rewards comments that have diverse symbol usage,
                    // but prohibits them from inflating points beyond the context of their topSymbolHigh (i.e: consider how a mention symbol can be worth many times more points than a coin symbol).
                    if (thisWordRef.hasSymbols && thisWordRef.hasSymbols.length > 0 && thisComment.topSymbolHigh['1Hr']) {
                        const highSymbolWordStr = thisComment.topSymbolHigh['1Hr'].split(':').slice(2).join(':');
                        const maxPointsForNonHighSymbols = Math.floor((thisComment.points[timeBucketKey][highSymbolWordStr] / 2) / Object.keys(thisComment.symbolStartPoints).length);
                        let deductSymbolPoints = 0;
                        thisWordRef.hasSymbols.forEach((thisSymbolKey) => {
                            if ( thisSymbolKey !== thisComment.topSymbolHigh['1Hr'] && thisSymbolKey !== thisComment.topSymbolLow['1Hr'] ) {
                                const nonHighSymbolWordStr = thisSymbolKey.split(':').slice(2).join(':');
                                if (thisComment.points[timeBucketKey][nonHighSymbolWordStr]) {
                                    // console.warn(`Found invalid pointed symbol in comment:${thisComment.id} in word:${thisWordStr} that was neither topSymbolHigh nor topSymbolLow.`);
                                    if (thisComment.points[timeBucketKey][nonHighSymbolWordStr] > maxPointsForNonHighSymbols) {
                                        deductSymbolPoints = deductSymbolPoints + (thisComment.points[timeBucketKey][nonHighSymbolWordStr]-maxPointsForNonHighSymbols);
                                    }
                                }
                            }
                        });
                        if (deductSymbolPoints > 0) {
                            const correctedPointCount = Math.max(0, thisComment.points[timeBucketKey][thisWordStr] - deductSymbolPoints)
                            // if (deductSymbolPoints !== thisComment.points[timeBucketKey][thisWordStr]) console.warn(`Deducting ${deductSymbolPoints} from ${thisComment.points[timeBucketKey][thisWordStr]} points (${timeBucketKey}) for comment:${thisComment.id} for word:${thisWordStr}`);
                            correctedCommentPoints[timeBucketKey][thisWordStr] = correctedPointCount;
                        }
                    }

                    /////////
                    // 2. hashHype rule 92356 - a comment (x) can only earn points for a word at a maximum of once per ms. This ensures that when another user re-comments (y) word combo
                    // "go_!!_moon_!!_GME" and creates foundAt tstamps for "go_!!_moon_!!_GME", "moon_!!_GME" and "GME", comment x only earns once (for the longest shared sequence).
                    // To enforce this, we store a temporary record called comment.pointsRecords. Here we look at every pointed word, detect shared substrings, and reduce down those
                    // shared substrings by their foundAt tstamp. When shared substrings come from the same comment (y), they all have the same foundAt tstamp.
                    for (const [thisShortWordStr, pointsForThisWord] of Object.entries(thisComment.points[timeBucketKey])) {
                        if (!pointsForThisWord) continue; // didn't earn points anyway. no need to continue overlap check logic
                        const longWordRef = thisWordRef;
                        const shortWordRef = thisComment.words[thisShortWordStr];
                        if (longWordRef.word === shortWordRef.word) continue;

                        // hashHype rule - we don't make single word symbols take a hit for being part of longer sequences. They get to keep all of their points.
                        // Not only does this ensure that a comment is properly represented by it's top symbol, but it will save on cpu cycles as we return early.
                        if (shortWordRef.type === 'word' && shortWordRef.hasSymbols.length > 0) continue;

                        // Return as quickly as we can determine these 2 strings do not overlap
                        // The next lines cover overlaps of normal words, and 2dGrams which shortWord is not an exact match substring, but all of it's words fall within the span of longWord. This is possible because of skipword 2dGrams.
                        let wordsHaveOverlap = false;
                        const longWordSpan = [longWordRef.index[0], longWordRef.index[0] + longWordRef.word.length];
                        if (longWordRef.distance) longWordSpan[1] = longWordSpan[1] + longWordRef.distance;
                        const shortWordSpan = [shortWordRef.index[0], shortWordRef.index[0] + shortWordRef.word.length];
                        if (shortWordRef.distance) shortWordSpan[1] = shortWordSpan[1] + shortWordRef.distance;
                        if (shortWordSpan[0] >= longWordSpan[0] && shortWordSpan[1] <= longWordSpan[1]) wordsHaveOverlap = true;
                        if (!wordsHaveOverlap) continue;

                        // console.warn(`Detected overlapping words ${thisWordStr} and ${thisShortWordStr} in comment:${thisComment.id}`);
                        if (!thisComment.pointsRecords[timeBucketKey][thisWordStr] || !thisComment.pointsRecords[timeBucketKey][thisShortWordStr]) continue;
                        thisComment.pointsRecords[timeBucketKey][thisWordStr].forEach((thisLongWordFoundAtTstamp) => {
                            if (thisComment.pointsRecords[timeBucketKey][thisShortWordStr].indexOf(thisLongWordFoundAtTstamp) !== -1) {
                                // console.warn(`Detected that overlapping words ${thisWordStr} and ${thisShortWordStr} in comment:${thisComment.id} both earned points from the same re-comment.`);
                                // console.warn(`Deducting ${shortWordRef.pointVal} from ${thisComment.points[timeBucketKey][thisShortWordStr]} points (${timeBucketKey}) for comment:${thisComment.id} for word:${thisShortWordStr}`);
                                const deductPoints = shortWordRef.pointVal;
                                correctedCommentPoints[timeBucketKey][thisShortWordStr] = Math.max(0, correctedCommentPoints[timeBucketKey][thisShortWordStr] - deductPoints);
                            }
                        });
                    } // end Object.entries(thisComment.points[timeBucketKey])) {

                } //end for (const [thisWordStr, pointsForThisWord] of Object.entries(thisComment.points[timeBucketKey])) {

                /////////
                // 3. We are now ready to add in totalPoints for this word
                thisComment.totalPoints[timeBucketKey] = 0;
                for (const [thisWordStr, thisWordPoints] of Object.entries(correctedCommentPoints[timeBucketKey])) {
                    thisComment.totalPoints[timeBucketKey] = thisComment.totalPoints[timeBucketKey] + thisWordPoints;
                };
                thisComment.pointsAdjust = correctedCommentPoints;

            }; // end for (const [timeBucketKey, prevPoints] of Object.entries(thisComment.totalPoints)) {
        }); // end Object.values(self.pendingTopComments).flat().forEach

    } // end calcTotalPointsForPendingTopComments

    reducePendingTopComments() {
        const self = this;

        const topCommentsClone = self.newTopCommentsEntity();
        const finalTopCommentIds = {}; // {coin: ['id345', 'id0123', etc], stock: [etc], etc...} // For making sure there are no duplicate comments within each symbol type group

        for (const [thisSymbolKey, pendingTopCommentsForThisSymbol] of Object.entries(self.pendingTopComments)) {
            const thisSymbolSplit = thisSymbolKey.split(':');
            const thisSymbolType = thisSymbolSplit[1];
            const thisSymbolWord = thisSymbolSplit.splice(2).join(':'); // NOTE: THIS WILL NOT ACCOUNT FOR symbolAlias matches (and comments that have earned based on alias usage will be wrongly discarded here). Those comments will, however, still earn points for this symbols usage (to provide for another topComment to carry the torch)

            // 1. HashHype rule - first we will loop through the totalPoints['1Hr'] for each comment in this symbol group, then determine if any are outliers.
            // A comment may score suspiciously high if it slips through an edge case in our algo, or users discover a vulneribility and game the points. This
            // very basic math is our last defense in attempting to block comments that should not earn trend ranking.
            let stdDevCountMax = 5; // if the stDevCount is greater than {stdDevCountMax} we discard the comment from this symbol group
            let nonOutlierTotalPoints = null; // array of ints which represent only valid totalPoints['1Hr'] found in this comment group.
            let pointsMedian;
            let pointsStdDev;
            if (thisSymbolKey !== 'noSymbols' && pendingTopCommentsForThisSymbol.length >= 5) { // we can't assume any outliers with data sets smaller than 5, or within comments that don't belong to a common (symbol) group.
                let allTotalPoints = [];
                pendingTopCommentsForThisSymbol.forEach(thisComment => {
                    if (thisComment.totalPoints['1Hr']) allTotalPoints.push(thisComment.totalPoints['1Hr']);
                });
                if (allTotalPoints.length) {
                    allTotalPoints.sort();
                    pointsMedian = median(allTotalPoints);
                    pointsStdDev = std(allTotalPoints);
                    if (pointsStdDev !== 0) {
                        nonOutlierTotalPoints = [];
                        allTotalPoints.forEach((thisTotalPoints) => {
                            const diff = Math.abs(thisTotalPoints - pointsMedian);
                            if (diff === 0) {
                                nonOutlierTotalPoints.push(thisTotalPoints);
                                return;
                            }
                            const stDevCount = diff / pointsStdDev;
                            if (stDevCount < stdDevCountMax) nonOutlierTotalPoints.push(thisTotalPoints);
                        });
                    }
                } // end if (allTotalPoints.length) {
            } // end if (thisSymbolKey !== 'noSymbols'

            // Ok now we can proceed to select only the top scoring comment for each symbol, and flatten all of them (including comments with no symbols) into an array for sorting.
            let highestScoredSymbolComment = null;
            // let highestScoredSymbolCommentWith2dGram = null;
            pendingTopCommentsForThisSymbol.forEach((thisComment) => {
                if (self.topCommentsMustHaveSymbol && self.topCommentsMustHaveSymbolTypes.indexOf(thisSymbolType) === -1) {
                    // console.warn(`comment:${thisComment.id} contained no symbols of type ${self.topCommentsMustHaveSymbolTypes} and will be excluded from topComments.`)
                    return; // (though these comments still play a part in word reuse pointing)
                }

                if (thisSymbolKey === 'noSymbols' && finalTopCommentIds[thisSymbolType].indexOf(thisComment.id) === -1) {
                    // console.log(`Will add comment:${highestScoredSymbolComment.id} (no symbols) to our final selection of topCommentStats.comments.`)
                    finalTopCommentIds['noSymbols'] = finalTopCommentIds['noSymbols'] || [];
                    finalTopCommentIds['noSymbols'].push(thisComment.id);
                    topCommentsClone.comments['noSymbols'] = topCommentsClone.comments['noSymbols'] || [];
                    topCommentsClone.comments['noSymbols'].push(thisComment);
                    return;
                }

                // HashHype rule - when a comment has been assigned a topSymbolHigh, that symbol must have earned points for this comment to be selected as a topComment (and potentially surfacing it's symbol as a trend).
                // This rule is required so that if a comment scores very high because of good word combos and/or 2dGrams, BUT has a topSymbolHigh that isn't trending, we won't present it's symbol in the trending UI.
                // Adjust minPercOfTotalPointsForSymbol to change how strict this rule is. I.e: minPercOfTotalPointsForSymbol = 0.1 required that a symbol accounts for at least 10% of the comments totalPoints (or else comment is discarded).
                const minPercOfTotalPointsForSymbol = 0.1;
                let percOfTotalPointsFromThisSymbol = 0;
                if (thisComment.points['1Hr'][thisSymbolWord]) percOfTotalPointsFromThisSymbol = thisComment.points['1Hr'][thisSymbolWord] / thisComment.totalPoints['1Hr'];
                if (percOfTotalPointsFromThisSymbol < minPercOfTotalPointsForSymbol) {
                    // console.warn(`Must discard comment:${thisComment.id} for symbol group ${thisSymbolWord} because only ${percOfTotalPointsFromThisSymbol*100}% of it's totalPoints were earned from it's topSymbolHigh (${thisComment.topSymbolHigh['1Hr']}).`);
                    return;
                }

                if (nonOutlierTotalPoints !== null && nonOutlierTotalPoints.indexOf(thisComment.totalPoints['1Hr']) === -1) {
                    const stDevCount = Math.abs(thisComment.totalPoints['1Hr'] - pointsMedian) / pointsStdDev;
                    console.warn(`An outlier totalPoints (${thisComment.totalPoints['1Hr']}) was found on comment:${thisComment.id} (${stDevCount} stdDevs from median ${pointsMedian}). This comment will be discarded from ${thisSymbolKey} group (${pendingTopCommentsForThisSymbol.length} comments).`); // comment.points['1Hr']:`, thisComment.points['1Hr']);
                    return;
                }

                if (highestScoredSymbolComment === null || highestScoredSymbolComment.totalPoints['1Hr'] < thisComment.totalPoints['1Hr']) {
                    highestScoredSymbolComment = thisComment;
                }
            }); // end pendingTopCommentsForThisSymbol.forEach

            if (highestScoredSymbolComment) {
                // console.log(`Will add the highest scoring comment:${highestScoredSymbolComment.id} for ${thisSymbolKey} to our final selection of topCommentStats.comments.`)
                finalTopCommentIds[thisSymbolType] = finalTopCommentIds[thisSymbolType] || [];
                finalTopCommentIds[thisSymbolType].push(highestScoredSymbolComment.id);
                topCommentsClone.comments[thisSymbolType] = topCommentsClone.comments[thisSymbolType] || [];
                topCommentsClone.comments[thisSymbolType].push(highestScoredSymbolComment);
            }
        } // end for (const [thisSymbolKey, pendingTopCommentsForThisSymbol] of Object.entries(self.pendingTopComments)) {

        // Now loop through the topCommentsClone.comments[symbolType] arrays we just created, and sort, trim, finalize.
        for (const [thisSymbolType, topCommentsForThisSymbolType] of Object.entries(topCommentsClone.comments)) {
            ///////////
            // 2. Sort this final set of topComments descending (totalPoints)
            topCommentsForThisSymbolType.sort((commentA, commentB) => {
                return commentB.totalPoints['1Hr'] - commentA.totalPoints['1Hr'];
            });

            ///////////
            // 3. Trim off the lowest scoring comments (until we have the minimum required comments with symbols)
            topCommentsForThisSymbolType.splice(self.minTopCommentsPerSymbolType);

            /////////
            // 4. Assign the rank prop to each comment (they are already sorted)
            topCommentsForThisSymbolType.forEach((thisTopComment, thisTopCommentIndex) => {
                thisTopComment.rank = thisTopCommentIndex+1;
            });
        }

        return topCommentsClone;
        // return allChangedTopComments;
    }

    deleteLoserComments(freshTopCommentsStats, cback) {
        const self = this;
        // take a look at self.topComments.comments vs self.pendingTopComments. At this point, self.topComments.comments has been finalized and any comments inside self.pendingTopComments
        // that didn't make the cut are going to be deleted from redis. Essentially, every comment has 1 shot at becomming a top comment. HashHype does this because we want to prioritize hardware
        // for incoming new comments rather than repeatedly recalculate points for the same comments.
        const allFreshTopCommentIds = Object.values(freshTopCommentsStats.comments).flat().map((thisCom) => thisCom.id);
        const alreadyDeletedComments = []; // an array of comment id's that have already been deleted below. So we don't try to delete the same comment twice (a comment can belong to more than one symbol group)
        const deleteCommentPromises = [];
        for (const [thisSymbolKey, pendingTopCommentsForThisSymbol] of Object.entries(self.pendingTopComments)) {
            pendingTopCommentsForThisSymbol.forEach((thisPendingComment) => {
                if (allFreshTopCommentIds.indexOf(thisPendingComment.id) === -1 && alreadyDeletedComments.indexOf(thisPendingComment.id) === -1) {
                    // console.warn(`Deleting loser comment:${thisPendingComment.id}`);
                    alreadyDeletedComments.push(thisPendingComment.id)
                    deleteCommentPromises.push(new Promise( (resolve, reject) => {
                        self.removeCommentFromAll({comment: thisPendingComment}, () => {
                            resolve();
                        });
                    }));
                }
            });
        }
        Promise.all(deleteCommentPromises).then(() => {
            if (cback) cback();
        });
    }

    extractNew2dGramsFromTopComment(newlyPointedWordsForComment, comment, cback) { //alters comment in-place. cback returns an array of all 2dGrams currently in comment.
        // This is the last step (before saving to redis) performed on every newly pointed comment that has been deemed a topComment. We will inspect all words (word sequences) in this comment which have earned points,
        // and generate 2dGrams. 2dGrams are clustered word sequences that represent order. Then, future comments can earn points not just for re-commenting the same word sequences, but for commenting two or more
        // word sequences IN THE SAME ORDER as a past comment. For example:
        // Step 1: A new (stemmed) comment 'Hey reddit guy insane stuff GME is awesome and is going rocket moon Makes me happy comment about stocks and money'
        // Step 2: Some time passes and other users comment "guy_!!_insane" and "GME" and "going_!!_rocket_!!_moon" and "happy_!!_comment". extractNew2dGramsFromTopComment will create the following 2dGrams ONLY from the sequences which have earned points:
            // [ 'guy_!!_insane + GME', (clusters of 2)
            //   'GME + going_!!_rocket_!!_moon',
            //   'going_!!_rocket_!!_moon + happy_!!_comment',
            //   'guy_!!_insane + GME + going_!!_rocket_!!_moon', (clusters of 3)
            //   'GME + going_!!_rocket_!!_moon + happy_!!_comment',
            //   'guy_!!_insane + GME + going_!!_rocket_!!_moon + happy_!!_comment', (clusters of 4)
            //   etc... there is currently no limit on how long a cluster can be (other than the comment length max), and longer clusters are awarded more points when re-commented.
            // ]
        // Step 3: Each new 2dGram is saved as a new redis word entity, and added to wordToCommentsIndex and foundAt list - just like our symbols/bigrams/trigrams.
        // Step 4: More time passes, and new comments contain the same 2dGrams, receive points accordingly (see applyPointsToCommentForWord). Note that when a comment creates a new 2dgram within itself for the first time, it does not gain points until the next time.
        const self = this;
        const allNew2dGramStrings = []; // array wordRef.word strings (of word.type == 2dGram) produced by this function (but ONLY new 2dGrams for this topComments refresh. There may have already been 2dGrams on this comment - they are not returned in allNew2dGramStrings.)

        //////////
        // If this comment has less than 2 words which have earned, or will soon earn points, then we can't create a 2dGram and should return immediately.
        const previouslyPointedWordsForComment = Object.keys(comment.points['24Hr']);
        if (previouslyPointedWordsForComment.length + newlyPointedWordsForComment.length < 2) {
            // console.log(`comment:${comment.id} does not have enough pointed words to create any 2dGrams.`);
            if (cback) cback(allNew2dGramStrings);
            return;
        }
        /////////
        // Now count JUST the new word occurances which are valid to produce new 2dGrams. If none are, can return immediately.
        const validNewWordsFor2dGram = [];
        newlyPointedWordsForComment.forEach((thisNewlyPointedWord) => { // newlyPointedWordsForComment will not contain any dups when passed to extractNew2dGramsFromTopComment
            if (!comment.points['24Hr'][thisNewlyPointedWord] || // we aren't going to calc 2dGrams for words that re-occurred, but scored 0 points or just re-occurred for the first time and haven't yet been pointed. This means that a pointed word won't become valid for 2dGram until AFTER it get's recommented twice post comment creation (because points arent calculated until after this function returns).
                comment.words[thisNewlyPointedWord].type === '2dGram' || // obvi 2dGrams can't combine to create more 2dGrams
                comment.wordsFor2dGram.indexOf(thisNewlyPointedWord) !== -1 // This newly pointed word was already accounted for in a previous iteration of extractNew2dGramsFromTopComment. comment.wordsFor2dGram is the record persisted to comment object to make this repeat comparison more performant
            ) {
                // console.warn(`Won't attempt to create 2dGrams for word ${thisNewlyPointedWord} because it is worth 0 points, or hasn't yet been pointed. (comment:${comment.id})`);
                return;
            }
            validNewWordsFor2dGram.push(thisNewlyPointedWord);
        });
        if (validNewWordsFor2dGram.length === 0) {
            // console.log(`Already created all 2dGrams for comment:${comment.id} which could result from incoming points for words:`, newlyPointedWordsForComment);
            if (cback) cback(allNew2dGramStrings);
            return;
        }

        /////////
        // We now know that we should proceed with below (heavy) logic. Combine all new and old words which are valid to create 2dGrams together.
        const validWordsFor2dGram = comment.wordsFor2dGram.concat(validNewWordsFor2dGram);
        comment.wordsFor2dGram = validWordsFor2dGram; // and update our cached record on comment now that it's changed

        ///////////
        // Now take all the pointed words for this comment, condense them, and get them in the correct order.
        // We use a charachter index map because some of the pointed word sequences will overlap and we can only count each token once (i.e. "guy_!!_insane" AND "guy_!!_insane_!!_stuff" both earned points)
        let pointedCharsOrdered = {}; // {'{charIndex11}': 'g', '12': 'u', '13': 'y', '14': ' ', '15': 'i', '16': 'n', '17': 's', '18': 'a', '19': 'n', '20': 'e', '27': ' ', '28': 'G', '29': 'M', etc...}
        let lowestCharIndex = null;
        let highestCharIndex = 0;
        let totalTokenCount = 0;
        validWordsFor2dGram.forEach((thisValidWordStr) => {
            const thisWordRef = comment.words[thisValidWordStr];
            if (!thisWordRef) return;
            const thisWordString = thisWordRef.word.replaceAll('_!!_', ' '); // For this logic our word delimeter must be only 1 char (because our word indexes are based on a stemmed body with single space delimeters)
            thisWordRef.index.forEach((thisIndex) => { // remember that a word sequence may occur more than once in a single comment
                const startIndex = thisIndex;
                for (let curIndex = startIndex; curIndex < startIndex+thisWordString.length; curIndex++) {
                    if (pointedCharsOrdered[curIndex]) {
                        // we have a word overlap - prob between a bigram/trigram. Make sure we preserve all rawWords from both
                        pointedCharsOrdered[curIndex].rawWords = pointedCharsOrdered[curIndex].rawWords.concat(thisWordRef.rawWords);
                        pointedCharsOrdered[curIndex].hasSymbols = pointedCharsOrdered[curIndex].hasSymbols.concat(thisWordRef.hasSymbols);
                    } else {
                        const thisChar = thisWordString[curIndex-startIndex];
                        pointedCharsOrdered[curIndex] = {
                            index: curIndex,
                            char: thisChar,
                            rawWords: thisWordRef.rawWords,
                            hasSymbols: thisWordRef.hasSymbols
                        };
                        if (thisChar === ' ') ++totalTokenCount;
                    }
                    if (curIndex > highestCharIndex) highestCharIndex = curIndex;
                    if (lowestCharIndex === null || curIndex < lowestCharIndex) lowestCharIndex = curIndex;

                    if (typeof pointedCharsOrdered[curIndex-1] === 'undefined' && curIndex !== 0) {
                        pointedCharsOrdered[curIndex-1] = {index: curIndex-1, char: ' ', rawWords: [], hasSymbols: []}; // Prob just jumped between two words. Make sure we represent the distance between in pointedCharsOrdered via a single space.
                        if (lowestCharIndex === null || curIndex-1 < lowestCharIndex) lowestCharIndex = curIndex-1;
                        ++totalTokenCount;
                    }
                }
            });
        });
        if (highestCharIndex) { // make sure the last token also has a trailing space for below logic.
            pointedCharsOrdered[highestCharIndex+1] = {index: highestCharIndex+1, char: ' ', rawWords: [], hasSymbols: []};
            ++totalTokenCount;
        }
        if (lowestCharIndex && pointedCharsOrdered[lowestCharIndex].char === ' ') { // make sure the first token does not have a preceding space. If so, we counted one too many tokens above.
            delete pointedCharsOrdered[lowestCharIndex];
            --totalTokenCount;
        }
        // console.log('comment.stemmedBody', comment.id, comment.stemmedBody);
        // console.log('pointedCharsOrdered', pointedCharsOrdered);
        // console.log('totalTokenCount', totalTokenCount);


        ///////////////
        // Now that all charachters from all pointed words have been parsed together in order, and all symbols/raw words are still associated with each charachter (pointedCharsOrdered), let's combine
        // those charachters back together into an ordered array of wordRefs (pointedWordsOrdered). We can then use that array to run ngrams and get all possible combos, this includes "skip word" combos. i.e:
        // Given ['guy', 'insane', 'GME', 'going', 'rocket', 'moon', 'happy', 'comment']
        // 2dgrams would include guy_!!_insane_!!_GME_!!_going_!!_rocket  AND  guy_!!_GME_!!_going_!!_rocket  (and all other permutations that exceed minTokenClusterLengthFor2dGram)
        const pointedWordsOrdered = []; // array of wordrefs
        let curExtractingToken = '';
        let curExtractingTokenIndex = 0;
        let curExtractingTokenRawWords = [];
        let curExtractingTokenHasSymbols = [];
        let prevCharObj = null;
        for (let [thisCharObjIndex, thisCharObj] of Object.entries(pointedCharsOrdered)) {
            if (curExtractingToken === '') {
                // just started a new token.
                curExtractingTokenIndex = thisCharObj.index;
            }

            if (thisCharObj.char === ' ' && curExtractingToken.length > 0) {
                // just completed a token.
                const newWordRefObject = wordModel.createWordRefObject({
                    type: '2dGram-pending', // this is pseudo type just to assist computations. This wordRef will not be saved to DB, it will be used to construct 2dGrams below.
                    word: curExtractingToken,
                    rawWords: prevCharObj.rawWords || [],
                    hasSymbols: prevCharObj.hasSymbols || [],
                    index: [curExtractingTokenIndex], // remember that wordRefs use an array for index
                });
                pointedWordsOrdered.push(newWordRefObject);

                // reset all loop refs
                curExtractingToken = '';
                curExtractingTokenIndex = 0;
                curExtractingTokenRawWords = [];
                curExtractingTokenHasSymbols = [];
                continue;
            }

            if (thisCharObj.char !== ' ') {
                prevCharObj = thisCharObj;
                curExtractingToken = curExtractingToken + thisCharObj.char;
            }
        }
        // console.warn('stemmedBody', comment.stemmedBody);
        // console.warn('pointedCharsOrdered', pointedCharsOrdered);
        // console.warn('validWordsFor2dGram', validWordsFor2dGram);
        // console.warn('pointedWordsOrdered', pointedWordsOrdered);
        if (pointedWordsOrdered.length < self.minTokenClusterLengthFor2dGram) {
            // console.warn(`comment:${comment.id} does not have enough pointed tokens to create any 2dGrams (${pointedWordsOrdered.length}/${self.minTokenClusterLengthFor2dGram}).`);
            if (cback) cback(allNew2dGramStrings);
            return;
        }
        if (pointedWordsOrdered.length > self.maxTokenClusterLengthFor2dGram) {
            // console.warn(`comment:${comment.id} has too many pointed tokens to compute all possible 2dGram combinations (${pointedWordsOrdered.length}/${self.maxTokenClusterLengthFor2dGram}).`);
            if (cback) cback(allNew2dGramStrings);
            return;
        }

        // Now get all possible combinations of above produced pointedWordsOrdered, then form all of those combinations into 2dGram wordRefs.
        const allWordClusters = self.extractAllWordCombos(pointedWordsOrdered, self.minTokenClusterLengthFor2dGram); // returns array of arrays of objects: [{wordRef: wordRefObj, index: int}, etc...]
        // console.log(`comment:${comment.id} had ${pointedWordsOrdered.length} pointed words which produced ${allWordClusters.length} possible word combinations to form 2dGrams.`);
        const all2dGrams = [];
        allWordClusters.forEach((thisWordCluster) => {
            // Convert thisWordCluster (array of objects [{wordRef: wordRefObj, index: int}, etc...]) into a single 2dGram wordRef
            const this2dGram = wordModel.createWordRefObject({
                type: '2dGram',
                word: [], // this MUST be a string of wordRef. Will join below after all parts are added.
                rawWords: [],
                hasSymbols: [],
                index: [], // remember that wordRefs use an array for index (even though 2dGrams only ever have one index)
                rawIndex: [],
                distance: 0
            });
            let prevTokenEndIndex = null; // so we can total the distance between all tokens in this combo
            thisWordCluster.forEach((thisClusterPart) => { // each thisClusterPart is object {wordRef: wordRefObj, index: int}
                const thisClusterPartWordRef = thisClusterPart.wordRef;
                this2dGram.word.push(thisClusterPartWordRef.word);
                this2dGram.rawWords = this2dGram.rawWords.concat(thisClusterPartWordRef.rawWords);
                this2dGram.hasSymbols = this2dGram.hasSymbols.concat(thisClusterPartWordRef.hasSymbols);
                if (!this2dGram.index[0] || thisClusterPartWordRef.index[0] < this2dGram.index[0]) this2dGram.index[0] = thisClusterPartWordRef.index[0];
                if (prevTokenEndIndex !== null) {
                    this2dGram.distance = this2dGram.distance + (thisClusterPartWordRef.index[0] - (prevTokenEndIndex+2)); // +2 because we don't count a single space between tokens as distance, nor the first charachter in this current word.
                }
                prevTokenEndIndex = thisClusterPartWordRef.index[0]-1 + thisClusterPartWordRef.word.length; // this is the index of the final charachter in the previous token
            });


            ///////////
            // HashHype rule - 2dGrams with a distance of 0 are invalid. The point of a 2dGram is to frame an unpointed portion of a comment between 2 or more pointed portions.
            // If a 2dGram is back-to-back pointed words, then we simply allow those words to earn their points individually (a smaller sum). This also helps eliminate the potential
            // for inflated points when a user is simply quoting another user (whether that quote is sincere, or an attempt to game points).
            if (this2dGram.distance === 0) {
                // console.warn(`Discarding 2dGram with a distance of 0 on comment:${comment.id}:`, comment.stemmedBody);
                // console.warn(`Discarded 2dGram:`, this2dGram);
                return; // continue allWordClusters.forEach loop so this invalid 2dGram isn't pushed to all2dGrams.
            }

            //////////
            // HashHype rule - A word sequence can't earn points if it's length is greater than 70% the length of the entire comment body. This blocks comments from
            // earning tons of 2dGram points when many users are quoting the same phrase but not adding anything original to it. We only apply this rule to long comments (greater than
            // minCommentLengthForMaxWordLengthRule) because there are so many short comments that have key phrases which are understandably most of that short comment body.
            // I.e: "you know you are a redneck when GME" does not deserve to launch GME to rank 1 comment.
            const minCommentLengthForMaxWordLengthRule = 70;
            const maxWordSeqLength = 0.7; // a percentage of the length of comment.stemmedBody
            if (comment.stemmedBody.length >= minCommentLengthForMaxWordLengthRule) {
                const thisWordStrSpaced = this2dGram.word.join(' ');
                const thisWordStrLength = thisWordStrSpaced.length + this2dGram.distance;
                const wordStringPercOfBody = thisWordStrLength / comment.stemmedBody.length;
                if (wordStringPercOfBody > maxWordSeqLength) {
                    // console.warn(`2dGram sequence was too long and will not be saved to comment. The 2dGram spanned ${wordStringPercOfBody * 100}% of the entire body comment:${comment.id}`, this2dGram.word);
                    return; // continue allWordClusters.forEach loop so this invalid 2dGram isn't pushed to all2dGrams.
                }
            }

            // remove dups
            this2dGram.rawWords = [...new Set(this2dGram.rawWords)];
            this2dGram.hasSymbols = [...new Set(this2dGram.hasSymbols)];

            // Now we must also establish rawIndex for this 2dGram using the combined rawWords
            let rawIndex = null;
            this2dGram.rawWords.forEach((thisRawWordSeq) => {
                const thisRawIndex = comment.body.indexOf(thisRawWordSeq);
                if (thisRawIndex === -1) return;
                // For 2dGrams, we will only ever have 1 index and rawIndex. For rawIndex, we are going to take the index of the first rawWord occurance.
                if (rawIndex === null || rawIndex > thisRawIndex) rawIndex = thisRawIndex;
            });
            this2dGram.rawIndex[0] = rawIndex;

            // Finally ready to save this new 2dGram wordRef
            all2dGrams.push(this2dGram);
        });


        ////////////
        // Last, save our the above 2dGram wordRef objects to our comment.words object, then also create full word objects for the 2dGrams and save to redis.
        const wordRefSavePromises = [];
        const wordSavePromises = [];
        all2dGrams.forEach((this2dGram) => {
            this2dGram.word = this2dGram.word.join('_!!_'); // convert it to it's proper string form now.
            const newWordAbsKey = wordModel.generateWordObjectKey(this2dGram.word);
            // add wordRef to comment
            if (!comment.words[this2dGram.word]) { // first check if already exists
                // console.warn(`comment:${comment.id} earned a new 2dGram: ${this2dGram.word}`, this2dGram)
                comment.words[this2dGram.word] = this2dGram; // This comment will be saved at the bottom of refreshTopComments
                wordRefSavePromises.push(new Promise( (resolve, reject) => {
                    // Add a foundAt tstamp for this word and save this comment to it's WordToCommentsIndex (creating one if it does not yet exist)
                    wordModel.addFoundAtTstampForWord(this2dGram.word, comment, self.redisClient, () => { // this must be done BEFORE registerWordToCommentsIndex or the foundAt tstamp will be cancelled as dup word by same user.
                        wordModel.registerWordToCommentsIndex(this2dGram.word, comment, self.redisClient, () => {
                            allNew2dGramStrings.push(this2dGram.word);
                            resolve();
                        });
                    });
                })); // end wordRefSavePromises.push
            }
        }); //end all2dGrams.forEach(

        Promise.all(wordRefSavePromises).then(() => {
            commentModel.saveCommentObject(comment, self.redisClient, () => {
                if (cback) cback(allNew2dGramStrings);
            });
        });
    }
    extractAllWordCombos(wordRefs = [], minComboLength = 4) { // returns array of arrays of objects: [[{wordRef: wordRefObj, index: int}, etc...], [{wordRef: wordRefObj, index: int}, etc...], etc...]
        if (!wordRefs || !wordRefs.length) return [];
        // This function takes an array of wordRef objects and returns all possible combinations of those words, respecting order.
        // However, it does allow for "skip words", or, a combination of words which one or more words is omitted from the middle.
        // When minComboLength is greater than 0, and produced cominations of shorter length will be discarded and not returned.
        // i.e: given: ['guy', 'insane', 'GME', 'going', 'rocket', 'moon', 'happy', 'comment'] and minComboLength = 4
        // some possible wordCombos could be: ['guy', 'insane', 'GME', 'going'] AND ['guy', 'GME', 'going', 'rocket'] or ['insane', 'rocket', 'happy', 'comment'], ['insane', 'GME', 'rocket', 'happy', 'comment'] etc...

        // First extract all possible pairs of 2, then they will be extended below in recursive "combineSkipWords" function.
        const allSkipWordsSets = [];
        const allPossibleTokenClusters = []; // array of arrays of wordRefs
        wordRefs.forEach((startingPointedWord, startingWordIndex) => {
            const thisWordSubset = wordRefs.slice(startingWordIndex);
            if (thisWordSubset.length < 2) return;

            // thisSkipWordSet is array of arrays. always the first word (thisWordSubset[0]) plus 1 other word which comes later than the first.
            // Given ['guy', 'insane', 'GME', 'going', 'rocket', 'moon', 'happy', 'comment']
            // skipWords == [['guy', 'insane'], ['guy', 'GME'], ['guy', 'going'], ['guy', 'rocket'], ['guy', 'moon']]
            // Note below that our skipword arrays actually hold objects not strings. Above is for explanation only.
            const thisSkipWordSet = [];
            const totalPossibleSkipWords = thisWordSubset.length - 1;
            for (let thisSkipWordCount = 0; thisSkipWordCount < totalPossibleSkipWords; thisSkipWordCount++) {
                const endIndex = thisSkipWordCount+1;
                ///////////
                // HashHype rule - a 2dGram can't have the same token twice in a row. I.e: "I love GME go moon :smile_emoji: :smile_emoji: :smile_emoji: Let's go!"
                // Now we will loop through thisTokenSet and condense any sequence of the same word into just one occurance: "I love GME go moon :smile_emoji: Let's go!"
                if (thisWordSubset[0].word === thisWordSubset[endIndex].word) {
                    // console.log(`Dup sequential words are not allowed:`, thisWordSubset[0].word, thisWordSubset[endIndex].word);
                    continue;
                }
                thisSkipWordSet.push([
                    {wordRef: thisWordSubset[0], index: startingWordIndex},
                    {wordRef: thisWordSubset[endIndex], index: startingWordIndex+endIndex}
                ]);
            }

            allSkipWordsSets.push(thisSkipWordSet);
        });

        // This takes all possible pairs of 2 words (from above), then loops over each of them, recursively extending beyond the last word in each set
        // until we have all possible combinations of all lengths (greater than or equal to minComboLength).
        const combineSkipWords = (curSkipWordsByWord, allCombinations = []) => {
            let foundNewCombosThisLoop = false; // once this recursive function has extended all skipWord combos to be as long as possible, this flag remains false and we return the final val from this function.
            const newSkipWordCombos = [];
            curSkipWordsByWord.forEach((thisSkipWordsSet, thisSkipWordsSetIndex) => {
                newSkipWordCombos[thisSkipWordsSetIndex] = newSkipWordCombos[thisSkipWordsSetIndex] || [];
                thisSkipWordsSet.forEach((thisSkipWords) => {
                    const appendableSkipWords = curSkipWordsByWord[thisSkipWords[thisSkipWords.length-1].index]; // which skip word combos can possibly follow thisSkipWords[0]
                    if (!appendableSkipWords || !appendableSkipWords.length) {
                        newSkipWordCombos[thisSkipWordsSetIndex].push(thisSkipWords);
                        return;
                    }
                    foundNewCombosThisLoop = true;
                    appendableSkipWords.forEach((thisAppendableSkipWords) => {
                        const appendThese = thisAppendableSkipWords.slice(1);
                        const thisCombo = thisSkipWords.concat(appendThese);
                        newSkipWordCombos[thisSkipWordsSetIndex].push(thisCombo);
                        if (thisCombo.length >= minComboLength) allCombinations.push(thisCombo);
                    });
                });
            });

            if (!foundNewCombosThisLoop) {
                return allCombinations;
            } else {
                return combineSkipWords(newSkipWordCombos, allCombinations);
            }
        }

        const allWordClusters = combineSkipWords(allSkipWordsSets); // the result of combining all possible permutations of skipwords
        return allWordClusters;
    } // end extractAllWordCombos


    addSymbolsDataToComment(comment, cback) { //alters comment in-place
        const self = this;
        comment.symbols = comment.symbols || [];
        const symbolKeysFromWordRefs = Object.values(comment.words).map(wordRef => wordRef.hasSymbols);
        const allSymbolKeys = [...new Set(symbolKeysFromWordRefs.flat())];

        // console.log(`Populating comment:${comment.id} with full symbol objects:`, allSymbolKeys);
        if (allSymbolKeys.length === 0) {
            // console.log(`A topComment has no symbols: ${comment.body}`);
            if (cback) cback();
            return;
        }
        // allSymbolObjectsForComment will be populated using getCached - our most performant redis get method, but data may be stale if other processes are manipulating the objects.
        const allSymbolObjectsForComment = [];
        allSymbolKeys.forEach((thisSymbolKey) => {
            self.redisClient.get(thisSymbolKey, (gotSymbol) => {
                allSymbolObjectsForComment.push(gotSymbol);
                if (allSymbolObjectsForComment.length === allSymbolKeys.length) {
                    comment.symbols = allSymbolObjectsForComment.filter(Boolean); // Remove falsies (not found in redis)
                    if (cback) cback();
                }
            });
        });
    }

    applyTopCommentsTrendHistory(freshTopCommentsStats, cback) { // alters this.topComments in-place.
        const self = this;
        // This function gets stats:topTrends from redis (see topTrendStats.js) and checks for matching trends in any of our topComments. If found,
        // we use historical properties like trend.decay to penalize the comment's ranking.

        // Each topComments.comments object must maintain it's point based ranking (comment.rank) to ensure accurate historical data.
        // We instead hold a seperate property (comment.rankAdjust) which can be used in rendering logic to supress comments with high decay/low volatility.
        self.redisClient.get(self.topTrendsStatsKey, (topTrendsStats) => {

            // const commentsBySymbolType = {}; // {coin: [comment5, comment3], etc...} -
            // self.topComments.comments.forEach((thisTopComment) => {
            for (const [symbolTypeGroup, theseTopComments] of Object.entries(freshTopCommentsStats.comments)) {
                theseTopComments.forEach((thisTopComment) => {

                    let topSymbolWord = null;
                    if (thisTopComment.topSymbolHigh['1Hr']) {
                        topSymbolWord = thisTopComment.topSymbolHigh['1Hr'].split(':').slice(2).join(':');
                    }
                    if (!topSymbolWord) return;

                    // Next, check if this comment matches on of our topTrends
                    let matchedTopTrend = null;
                    topTrendsStats.trends.some((thisTopTrend) => {
                        if (thisTopTrend.word === topSymbolWord) {
                            matchedTopTrend = thisTopTrend;
                            return true; // break some loop
                        }
                    });
                    if (!matchedTopTrend) return;

                    // We found a match, now apply changes to thisTopComment based on historical props on matchedTopTrend
                    if (matchedTopTrend.decay) {
                        thisTopComment.rankAdjust = thisTopComment.rank + Math.round(matchedTopTrend.decay * self.minTopCommentsPerSymbolType);
                        thisTopComment.rankAdjust = Math.max(thisTopComment.rankAdjust, 0);
                        // console.log(`The comment:${thisTopComment.id} rank was adjusted from ${thisTopComment.rank} to ${thisTopComment.rankAdjust} because it's topSymbol (${matchedTopTrend.word}) contained a decay of ${matchedTopTrend.decay}`);
                    }
                }); // end theseTopComments.forEach

            }; // end for (const [symbolTypeGroup, theseTopComments]

            if (cback) cback();
        });
    }

    isDiscardComment(comment) {
        // This process includes rules around which comments should be excluded in trend analysis. Ie: comments that are from not relevant users
        let shouldDiscard = false;

        if (this.quotedCommentsAreNeverTopComments && comment.isQuoted) {
            shouldDiscard = true;
            // console.warn(`Discarded quoted comment:${comment.id}`);
            ++this.quotedCommentsDiscardCount;
            return;
        }

        // Check the comment age. Delete if it's too old.
        const isYoungComment = Date.now() - comment.foundAt < this.trackCommentsFor;
        if (!isYoungComment) {
            shouldDiscard = true;
            console.warn(`A comment is now too old and will be discarded: ${comment.id}`);
            return shouldDiscard;
        }

        // 2. has the user been marked as not relevant. Comments will be discarded first by the fetchRedditComments process, but consider
        // this a backup to catch any offending comments which may have already been saved to redis (before the not relevant rule was established)
        if (this.trainingNotRelevant) {
            const notRelUserIndex = this.trainingNotRelevant.users.findIndex((thisUser) => thisUser.username === comment.author.name);
            if (notRelUserIndex !== -1) {
                shouldDiscard = true;
                console.warn(`Comment will be discarded because user ${comment.author.name} is not relevant: ${comment.id}`);
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

        // 3. HashHype rule - no comment should have earned points on every single word combination possible. It was found that when this happens,
        // it was usually because a single user posted an identical comment more than once, was a single word comment with no additional context, or was a comment by bots
        // that posted the same canned comments under different usernames.
        const allTriGramsInComment = Object.values(comment.words).filter(wordRef => wordRef.type === 'trigram'); // the quickest way to do this is only look at the trigrams. If they all got pointed, the whole comment got pointed.
        // We will only enforce this rule on comments that have at least 3 trigrams (5 tokens). We don't want to be too agressive in removing short comments that validly earn points on all words.
        // i.e: "I love GME" may just be something that many unique users are saying at the same time, not a fishy copy/paste duplicate comment or a canned bot.
        if (allTriGramsInComment.length >= 3) {
            let pointedTrigramCount = 0;
            allTriGramsInComment.forEach((thisTriGram) => {
                if(typeof comment.points['1Hr'][thisTriGram.word] !== 'undefined') ++pointedTrigramCount; // we store point records that were calculated to 0
            });
            if (pointedTrigramCount === allTriGramsInComment.length) {
                shouldDiscard = true;
                // console.warn(`Comment will be discarded because all of it's word combos earned points. Suspected dup comment:${comment.id} by user ${comment.author.name}. Comment body: ${comment.body}`);
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
            // 1. If this is a user just marked not relevant, loop through this.topComments and delete any existing comments by that user.
            if (changedKey.indexOf('user:') !== -1) {
                const notRelevantUser = changedKey.replace('user:', '');
                Object.values(self.topComments.comments).flat().forEach((thisComment) => {
                    if (thisComment.author && thisComment.author.name === notRelevantUser) self.removeCommentFromTopComments(thisComment.id); // (also removes from redis throttle cache)
                });
            }
            // 2. If this training change deleted a comment, then it must also be locally deleted from this.topComments, and from redis throttle cache
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

    removeCommentFromTopComments(removeCommentId, cback) { // Alters self.topComments in place
        const self = this;
        // delete the instance of this object stored directly on stats:topComments
        const revisedTopComments = {comments: {}};
        for (const [symbolTypeGroup, theseTopComments] of Object.entries(self.topComments.comments)) {
            theseTopComments.forEach((thisComment) => {
                if (thisComment.id !== removeCommentId) {
                    revisedTopComments.comments[symbolTypeGroup] = revisedTopComments.comments[symbolTypeGroup] || [];
                    revisedTopComments.comments[symbolTypeGroup].push(thisComment);
                    return;
                }
                console.log(`Removing comment from ${this.topCommentsStatsKey}. Comment: ${removeCommentId}`);
            });
        };
        this.topComments.comments = revisedTopComments.comments;
        if (cback) cback();
    }

    getWordToCommentsIndexForTimeRange(wordString, maxAge = 3600000, cback) { // defaults to return only commentIds that are less than 1 hr old
        const self = this;
        const thisIndexKey = `index:wordToComments:${wordString}`;
        const now = Date.now();
        self.redisClient.zrange(thisIndexKey, now - maxAge, now, (commentIdsInRange) => {
            if (cback) cback(commentIdsInRange);
        });
    }

    removeCommentFromWordToCommentIndexes(commentId, associatedWords, cback) {
        const self = this;
        const zremPromises = [];
        associatedWords.forEach((wordString) => {
            const thisIndexKey = `index:wordToComments:${wordString}`;
            zremPromises.push(new Promise( (resolve, reject) => {
                self.redisClient.zrem(thisIndexKey, [commentId], () => {
                    resolve();
                });
            }));
        });
        Promise.all(zremPromises).then(() => {
            if (cback) cback();
        });
    }

    removeCommentFromAll(argOpts = {}, cback) {
        const self = this;
        const opts = Object.assign({
            comment: undefined,
            commentId: undefined,
            associatedWords: undefined
        }, argOpts);
        if (opts.comment && !opts.associatedWords) {
            opts.associatedWords = Object.keys(opts.comment.words);
        }
        if (opts.comment && !opts.commentId) {
            opts.commentId = opts.comment.id;
        }

        const deletePromises = [];

        if (opts.commentId) {
            deletePromises.push(new Promise( (resolve, reject) => {
                self.removeCommentFromTopComments(opts.commentId, () => {
                    resolve();
                });
            }));
        }

        if (opts.commentId && opts.associatedWords) {
            deletePromises.push(new Promise( (resolve, reject) => {
                self.removeCommentFromWordToCommentIndexes(opts.commentId, opts.associatedWords, () => {
                    resolve();
                });
            }));
        }

        if (opts.commentId && opts.comment !== undefined) { // In some logic this function may be called for a comment which was not found in redis (returned null). If that was the case, we don't want to attempt to delete right now.
            opts.comment.deleted = true; // Set this local flag so that the comment can't be re-saved later if it's being held somewhere in this process's live memory (is honored in redisClient.js "set")
            deletePromises.push(new Promise( (resolve, reject) => {
                commentModel.deleteCommentObject(opts.comment, self.redisClient, () => {
                    resolve();
                });
            }));
        }

        Promise.all(deletePromises).then(() => {
            if (cback) cback();
        });
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
        const newTopComments = {
            absKey: initial.absKey || this.topCommentsStatsKey,
            comments: {}, // {stock: [comment8, comment3], coin: [etc..], etc..}
            ui: {
                viewPath: '/ui/views/topCommentStats.jsx.js'
            },
            saveCount: 0
         }
         if (this.topComments && this.topComments.saveCount) newTopComments.saveCount = this.topComments.saveCount;

         return newTopComments;
    }


    storeNewTopCommentsStats() {
        const self = this;
        if (self.refreshTopCommentsIsBusy()) return;

        const thisRefreshTstamp = Date.now();
        self.curActiveTopCommentsRefresh = thisRefreshTstamp;

        self.commentsCountForLastTopCommentsRefresh = null; // calculated inside refreshTopComments
        self.storeNewTopCommentsStatsIsPending = true;

        self.refreshTopComments(self.topComments, (freshTopCommentsStats) => {
            self.topComments = freshTopCommentsStats;

            const refreshDuration = (Date.now() - thisRefreshTstamp) / 1000;
            if (self.curActiveTopCommentsRefresh === thisRefreshTstamp) {
                // Release the lock on storeNewTopCommentsStatsIsPending now, even though we haven't yet saved self.topCommentsStats back to DB. This helps us return faster,
                // and the next refresh loop will be accessing our locally held self.topCommentsStats anyway.
                self.storeNewTopCommentsStatsIsPending = false;
                self.redisClient.set(self.topCommentsStatsFullKey, freshTopCommentsStats); // first save our local, full self.topComments (big - holds full comment objects)
                self.saveTopCommentsStatsMin(); // Now save our minified version of freshTopCommentsStats for use by browser or other processes.

                console.log(`Succesfully updated stats:topComments (started at ${thisRefreshTstamp}). Total duration: ${refreshDuration} seconds`);

                const pointed2dGramRecordVals = Object.values(self.topCommentsWithPointed2dGramLastRefresh);
                console.log(`${pointed2dGramRecordVals.length} comments generated ${sum(pointed2dGramRecordVals)} new 2dGrams in the last ${refreshDuration} seconds.`);
                self.topCommentsWithPointed2dGramLastRefresh = {};

                if (self.quotedCommentsDiscardCount) console.log(`Discarded ${this.quotedCommentsDiscardCount} quoted comments in the last ${refreshDuration} seconds.`);
                self.quotedCommentsDiscardCount = 0;
            } else {
                console.warn(`A cancelled topCommentsRefresh finally returned (started at ${thisRefreshTstamp}). Total duration: ${refreshDuration} seconds`);
            }
        });
    }

    saveTopCommentsStatsMin() {
        const self = this;
        // In addition to saving stats:topComments to redis, we also keep a "stats:topComments". This is because stats:topComments holds full comment objects, which can get pretty huge.
        // things like comment.pointsRecords, comment.words, continue to grow over time. The full stats:topComments should not be sent to the client, or pulled from redis by other processes like archiveKeysToDisk.
        const topCommentStatsMin = self.newTopCommentsEntity();
        for (const [symbolCat, comments] of Object.entries(self.topComments.comments)) {
            comments.forEach((thisTopComment) => {
                topCommentStatsMin.comments[symbolCat] = topCommentStatsMin.comments[symbolCat] || [];
                topCommentStatsMin.comments[symbolCat].push(commentModel.minimizeForClient(thisTopComment));
            });
        };
        self.redisClient.set(self.topCommentsStatsKey, topCommentStatsMin);
    }

    refreshTopCommentsIsBusy() {
        const self = this;
        // This function allows this process to adapt to hardware load to make sure calls to refreshTopComments don't continually hang the process.
        let isBusy = false;

        // If maxOverlapsPerTopCommentsRefresh overlaps occur during a single attempt to run refreshTopComments, then we must assume something got stuck, and didn't return properly.
        // As to not permanently freeze refreshTopComments attempts, we will unblock let the process regain stability on it's own. maxOverlapsPerTopCommentsRefresh is also used
        // when computing how much to adjust maxCommentsPerTopCommentsRefresh at the end of a refresh interval.
        self.maxOverlapsPerTopCommentsRefresh = 5;

        // maxCommentsPerTopCommentsRefresh will go down by 10% for EVERY overlap. Then, each time there a call to refreshTopComments completes with NO overlap, maxCommentsPerTopCommentsRefresh
        // is changed to the previous value in maxCommentsPerTopCommentsRefreshRecord. Each succesful iteration of refreshTopComments works backwards through maxCommentsPerTopCommentsRefreshRecord until it eventually is reset to be unlimited.
        self.loadAdjustPerTopCommentsRefreshOverlap = .1;
        self.maxCommentsPerTopCommentsRefreshRecord = self.maxCommentsPerTopCommentsRefreshRecord || [];

        ///////
        // 1. An existing call to refreshTopComments is still busy.
        if (self.storeNewTopCommentsStatsIsPending) {
            isBusy = true;
            if (self.overlapCountThisTopCommentsRefresh === null) self.overlapCountThisTopCommentsRefresh = 0; // how many times did code attempt to call storeNewTopCommentsStat while it was busy during JUST THIS INTERVAL.
            ++self.overlapCountThisTopCommentsRefresh;
            console.warn(`Detected overlap in calls to "storeNewTopCommentsStats" (${self.overlapCountThisTopCommentsRefresh}/${self.maxOverlapsPerTopCommentsRefresh}). Cancelling most recent call until pending call completes...`);

            // If 5 overlaps occur during a single attempt to run refreshTopComments, then we must assume something got stuck, and didn't return properly.
            // As to not permanently freeze refreshTopComments attempts, we will unblock and hope the process regains stability on it's own.
            if (self.overlapCountThisTopCommentsRefresh >= self.maxOverlapsPerTopCommentsRefresh) {
                self.setMaxCommentsPerTopCommentsRefresh();
                console.warn(`Forcefully cleared a pending storeNewTopCommentsStats timeout.`);
                self.overlapCountThisTopCommentsRefresh = 0;
                self.storeNewTopCommentsStatsIsPending = false;
                self.topCommentsWithPointed2dGramLastRefresh = {};
                isBusy = false;
            }

            return isBusy;
        }

        //////
        //2.  The process is not busy with an existing call to refreshTopComments. If this is a newly started refresh interval, check the last interval for any overlaps. Adjust maxCommentsPerTopCommentsRefresh accordingly.
        self.setMaxCommentsPerTopCommentsRefresh();

        return isBusy;
    }
    setMaxCommentsPerTopCommentsRefresh() {
        const self = this;
        if (self.commentsCountForLastTopCommentsRefresh === null) {
            self.overlapCountThisTopCommentsRefresh = 0;
            return; // This may be the very first topCommentsRefresh since process start. Can't compute maxCommentsPerTopCommentsRefresh yet.
        }

        let newMaxCommentsCount = null;
        if (self.overlapCountThisTopCommentsRefresh === 0) {
            self.maxCommentsPerTopCommentsRefreshRecord.pop();
            if (self.maxCommentsPerTopCommentsRefreshRecord.length){
                newMaxCommentsCount = self.maxCommentsPerTopCommentsRefreshRecord[self.maxCommentsPerTopCommentsRefreshRecord.length-1];
                newMaxCommentsCount = Math.ceil(newMaxCommentsCount);
                console.warn(`There were no overlapping calls to storeNewTopCommentsStats. maxCommentsPerTopCommentsRefresh has been adjusted up: ${self.maxCommentsPerTopCommentsRefresh}->${newMaxCommentsCount}`);
                console.warn(`Remaining maxCommentsPerTopCommentsRefreshRecords:`, self.maxCommentsPerTopCommentsRefreshRecord);
            } else {
                newMaxCommentsCount = null;
                if (self.maxCommentsPerTopCommentsRefresh !== newMaxCommentsCount) console.warn(`maxCommentsPerTopCommentsRefresh will be reset to null after recovering from previous overlaps. No current max limit.`);
            }
        } else {
            if (self.maxCommentsPerTopCommentsRefresh === null) self.maxCommentsPerTopCommentsRefresh = self.commentsCountForLastTopCommentsRefresh;
            newMaxCommentsCount = self.maxCommentsPerTopCommentsRefresh - (self.maxCommentsPerTopCommentsRefresh * (self.loadAdjustPerTopCommentsRefreshOverlap * Math.min(self.overlapCountThisTopCommentsRefresh, self.maxOverlapsPerTopCommentsRefresh)));
            newMaxCommentsCount = Math.max(newMaxCommentsCount, 10); // We need to be sure this never reaches 0 or process will stall.
            newMaxCommentsCount = Math.ceil(newMaxCommentsCount);
            if (self.maxCommentsPerTopCommentsRefreshRecord.length){
                if (self.maxCommentsPerTopCommentsRefreshRecord[self.maxCommentsPerTopCommentsRefreshRecord.length-1] !== newMaxCommentsCount) {
                    if (self.maxCommentsPerTopCommentsRefreshRecord[self.maxCommentsPerTopCommentsRefreshRecord.length-1] < newMaxCommentsCount) {
                        console.warn(`Will now reset maxCommentsPerTopCommentsRefreshRecord because the previous record is lower than current. It became out of sync.`);
                        self.maxCommentsPerTopCommentsRefreshRecord = [newMaxCommentsCount];
                    } else {
                        self.maxCommentsPerTopCommentsRefreshRecord.push(newMaxCommentsCount);
                    }
                }
            } else {
                self.maxCommentsPerTopCommentsRefreshRecord.push(newMaxCommentsCount);
            }
            console.warn(`There were ${self.overlapCountThisTopCommentsRefresh} overlapping calls to storeNewTopCommentsStats. maxCommentsPerTopCommentsRefresh was adjusted: ${self.maxCommentsPerTopCommentsRefresh}->${newMaxCommentsCount}`);
        }

        if (self.maxCommentsPerTopCommentsRefreshRecord.length > 100) console.warn(`maxCommentsPerTopCommentsRefreshRecord is getting long (${self.maxCommentsPerTopCommentsRefreshRecord.length} entries). Please inspect for memory leaks.`, self.maxCommentsPerTopCommentsRefreshRecord);
        self.maxCommentsPerTopCommentsRefresh = newMaxCommentsCount;
        self.overlapCountThisTopCommentsRefresh = 0;
    }

}

const thisCommentsStats = new TopCommentsStats();
export default TopCommentsStats;
