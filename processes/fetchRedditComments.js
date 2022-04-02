import snoowrap from 'snoowrap';
import yargs from 'yargs';
import RedisClient from '../utils/redisClient.js';
import commentModel from '../utils/objectModels/comment.js';
import redditClientConfig from '../utils/redditClient-config.js';

const argv = yargs(process.argv.slice(2)).argv;

// This class should be run independenly in it's own node.js process. It is the most basic implementation
// of simply pulling neww comments from a subreddit, then immediately saving them, unparsed, to redis.
// The other processes will seperately grab from redis for language processing.
class Reddit {
    constructor() {
        //Config options
        this.fetchSubReddits = ['wallstreetbets', 'CryptoCurrency'];
        this.fetchLoopIntervalTime = 5000;

        //Spam comment rules
        this.maxCommentLength = 280; //kinda like twitter.

        //Local vars
        this.redditApiClient = null;
        this.redisClient = null;

        //This process keeps track of which comments were recently fetched it doesn't store duplicates to redis.
        this.recentCommentRecordMaxLength = 1000;
        this.recentCommentRecord = [];

        self.interceptSigInt();

        console.log('A new fetchRedditComments process has just started...');
        const self = this;
        self.initRedisClient(() => {
            self.syncTrainingNotRelevant();
            self.createNewApiClient();
            self.initFetchLoopsForAllSubReddits();
        });
    }

    interceptSigInt() {
        const self = this;
        // By intercepting the SIGINT shutdown signal, this process can call any wrap-up routines before the process closes. https://pm2.keymetrics.io/docs/usage/signals-clean-restart/
        process.on('SIGINT', function() {
            self.redisClient.kill(() => {
                process.exit(0);
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        this.redisClient = new RedisClient({
            onConnect: () => {
                console.log('Connected to locally hosted redis DBs for topCommentStats class.');
                if(cback) cback();
            }
        });
    }

    initFetchLoopsForAllSubReddits(thisSubRedditIndex = 0) {
        const self = this;
        const thisSubReddit = self.fetchSubReddits[thisSubRedditIndex];
        if (!thisSubReddit) return;
        self.initFetchLoop(thisSubReddit);
        setTimeout(() => {
            self.initFetchLoopsForAllSubReddits(++thisSubRedditIndex);
        }, 1000); // offset fetch loops per subreddit as to better distribute CPU load
    }

    initFetchLoop(thisSubReddit) {
        const self = this;
        self.fetchLoopInterval = setInterval( () => {
            self.fetchCommentsForSubreddit(thisSubReddit, (rawComments) =>{
                const commentObjects = [];
                rawComments.forEach((rawComment) => {
                    if(self.isDupComment(rawComment) || self.isDiscardComment(rawComment)) return;
                    self.createCommentObjects(rawComment, commentObjects, thisSubReddit);
                });
                self.storeCommentsToRedis(commentObjects, thisSubReddit);
            });
        }, self.fetchLoopIntervalTime);
    }

    createNewApiClient() {
        this.redditApiClient = new snoowrap({
            userAgent: redditClientConfig.userAgent,
            clientId: redditClientConfig.clientId,
            clientSecret: redditClientConfig.clientSecret,
            refreshToken: redditClientConfig.refreshToken
        });
    }

    fetchCommentsForSubreddit(subName, cback) {
        if(!subName) {
            console.error('Must provide subName.');
            return;
        }
        this.redditApiClient.getNewComments(subName).then(cback).catch((err) => { // https://www.reddit.com/dev/api/#GET_new
            if (err) console.warn('Reddit API getNewComments error...', err.error);
            //if (err.error && err.error.code) console.warn('Error code: ', err.error.code);
        });
    }

    createCommentObjects(comment, commentObjects, subRedditName) {
        const self = this;
        const createdUtc = comment.created_utc || Date.now()/1000; // Reddit reports tstamps in SECONDS

        // First try to extract wordAssocs from reddit's "comment.media_metadata" object
        const wordAssocs = {};
        if (comment.media_metadata) {
            const wordsWithAssocs = Object.values(comment.media_metadata);
            wordsWithAssocs.forEach((thisWordAssoc) => {
                if (!thisWordAssoc.id || !thisWordAssoc.e || !thisWordAssoc.s || (!thisWordAssoc.s.u && !thisWordAssoc.s.gif)) {
                    console.warn(`A media_metadata entry in a Reddit comment was not valid:`, thisWordAssoc);
                    return;
                }

                let wordVal = thisWordAssoc.id;
                // 1. Convert reddit emote format back to standard emoji - i.e: 'emote|t5_2th52|4258' should be ':4258:'
                const wordValParts = wordVal.split('|')
                if (wordValParts.length === 3 && wordValParts[0] === 'emote') {
                    wordVal = `:${wordValParts[2]}:`;
                }

                let type = thisWordAssoc.e.toLowerCase();
                if (type === 'animatedimage') type = 'image';
                let mediaUrl = thisWordAssoc.s.u || thisWordAssoc.s.gif;
                wordAssocs[wordVal] = {assoc: mediaUrl, type: type};
            });
        }

        const thisCommentObject = commentModel.createNewCommentObject({
            source: `reddit_${subRedditName}`,
            body: comment.body, // we only use reddit's comment.body temporarily in our "isDiscardComment" function below. This gets reset in the extractWordsFromComments process from a parsed/sanitized originalBody.
            originalBody: comment.body_html,
            author: {name: comment.author.name},
            createdUtc: createdUtc * 1000,
            wordAssocs: wordAssocs
        });
        commentObjects.push(thisCommentObject);
    }

    storeCommentsToRedis(commentObjects, thisSubReddit) {
        const self = this;
        console.log(`Stored ${commentObjects.length} r/${thisSubReddit} comments in the last ${self.fetchLoopIntervalTime/1000} seconds.`);
        commentObjects.forEach((comment) => {
            self.redisClient.set(`rawComment:${comment.id}`, comment);
        });
    }

    isDupComment(rawComment) {
        if (this.recentCommentRecord.indexOf(rawComment.id) !== -1) return true;
        this.recentCommentRecord.unshift(rawComment.id);
        this.recentCommentRecord = this.recentCommentRecord.slice(0, this.recentCommentRecordMaxLength);
        return false;
    }

    isDiscardComment(rawComment) {
        // this process includes rules around which comments should be included in trend analysis. Ie: comments that are too long... comments that look like bots or spam, etc.
        let shouldDiscard = false;

        // 1. Discard if comment is too long
        if (rawComment.body.length > this.maxCommentLength) {
            shouldDiscard = true;
            // console.warn(`Comment discarded because its body char count exceeded the max (${rawComment.body.length}/${this.maxCommentLength}): ${rawComment.body}`);
            return shouldDiscard;
        }

        // 2. Training for not relevant content
        if (this.trainingNotRelevant) {
            // check if user has been marked as not relevant
            const notRelUserIndex = this.trainingNotRelevant.users.findIndex((thisUser) => thisUser.username === rawComment.author.name);
            if (notRelUserIndex !== -1) {
                shouldDiscard = true;
                console.warn(`Comment discarded for not relevant user: ${rawComment.author.name}`);
                return shouldDiscard;
            }
            // check for trainingNotRelevant.commentBodies (set in the topCommentStats process)
            const notRelCommentBodyIndex = this.trainingNotRelevant.commentBodies.indexOf(rawComment.body);
            if (notRelCommentBodyIndex !== -1) {
                shouldDiscard = true;
                console.warn(`Comment will be discarded because its body text was marked as not relevant. body:`, rawComment.body);
                return shouldDiscard;
            }
        }

        // 3. HashHype rule - no all-caps. These comments will often trigger false positive symbol matches (because stock/coin symbols are expected to be in all caps).
        //    Comments which no longer have case-based information become irrelevant when attempting to extract symbols and trends.
        const allCapsBody = rawComment.body.toUpperCase();
        if (allCapsBody === rawComment.body) {
            shouldDiscard = true;
            // console.warn(`Comment will be discarded because it was in all caps. body:`, rawComment.body)
            return shouldDiscard;
        }

        return shouldDiscard;
    }

    syncTrainingNotRelevant() {
        // This function gets training:notRelevant from redis (used in discarding comments from flagged users), and adds
        // a keyspace listener so local data is always synced with redis.
        const self = this;
        this.redisClient.get('training:notRelevant', (trainingObj) => {
            if (!trainingObj) return;
            self.trainingNotRelevant = trainingObj;
        });
        if (self.trainingNotRelevantIsSynced) return;
        self.trainingNotRelevantIsSynced = true;
        self.redisClient.on('message', (channel, message) => {
            if (channel === '__keyspace@0__:training:notRelevant') self.syncTrainingNotRelevant();
        });
        self.redisClient.subscribe('__keyspace@0__:training:notRelevant');
    }

}



const thisReddit = new Reddit();
export default Reddit;
