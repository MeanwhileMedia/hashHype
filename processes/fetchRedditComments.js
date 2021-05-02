import snoowrap from 'snoowrap';
import { v4 as uuidv4 } from 'uuid';
import RedisClient from '../utils/redisClient.js';

// This class should be run independenly in it's own node.js process. It is the most basic implementation
// of simply pulling neww comments from a subreddit, then immediately saving them, unparsed, to redis.
// The other processes will seperately grab from redis for language processing.
class Reddit {
    constructor() {
        //Config options
        this.subRedditName = 'wallstreetbets';
        this.fetchLoopIntervalTime = 5000;

        //Spam comment rules
        this.maxCommentLength = 280; //kinda like twitter.

        //Local vars
        this.fetchLoopInterval = null;
        this.redditApiClient = null;
        this.redisClient = null;

        //This process keeps track of which comments were recently fetched it doesn't store duplicates to redis.
        this.recentCommentRecordMaxLength = 50;
        this.recentCommentRecord = [];

        const self = this;
        self.initRedisClient(() => {
            self.syncTrainingNotRelevant();
            self.createNewApiClient();
            self.initFetchLoop();
        });
    }

    initRedisClient(cback) {
        const self = this;
        this.redisClient = new RedisClient({
            onConnect: () => {
                console.log('Connected new redis sub client for topCommentStats class.');
                if(cback) cback();
            }
        });
    }

    initFetchLoop() {
        if (this.fetchLoopInterval) clearInterval(this.fetchLoopInterval);
        this.fetchLoopInterval = setInterval( () => {
            this.fetchCommentsForSubreddit(this.subRedditName, (rawComments) =>{
                const commentObjects = [];
                rawComments.forEach((rawComment) => {
                    if(this.isDupComment(rawComment) || this.isDiscardComment(rawComment)) return;
                    this.createCommentObjects(rawComment, commentObjects);
                });
                this.storeCommentsToRedis(commentObjects);
            });
        }, this.fetchLoopIntervalTime);
    }

    createNewApiClient() {
        this.redditApiClient = new snoowrap({
            userAgent: 'code563',
            clientId: 'CRczORkXj04qiQ',
            clientSecret: 'dwC0N8a9H0dsM2j8qrU8O7WYc4mt1g',
            refreshToken: '517486034553-idlmDwRFIA_1o1iWE2SJuFy3UUwq-Q'
        });
    }

    fetchCommentsForSubreddit(subName, cback) {
        if(!subName) {
            console.log('Must provide subName.');
            return;
        }
        this.redditApiClient.getNewComments(subName).then(cback).catch((err, foo, bar) => {
            console.warn('Reddit API getNewComments error: ', err.error.code);
        });
    }

    createCommentObjects(comment, commentObjects) {
        const self = this;
        const createdUtc = comment.created_utc || Date.now()/1000; // Reddit reports tstamps in SECONDS
        const thisCommentObject = self.newCommentEntity({
            body: comment.body,
            author: {name: comment.author.name},
            createdUtc: createdUtc * 1000
        });
        commentObjects.push(thisCommentObject);
        if (comment.replies && comment.replies.length > 0) {
            console.log('Comment has replies...');
            comment.replies.forEach((reply) => {
                self.createCommentObjects(reply, commentObjects);
            });
        }
    }

    storeCommentsToRedis(commentObjects) {
        const self = this;
        console.log(`Now storing ${commentObjects.length} comments to redis...`);
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

        // Discard if comment is too long
        if (rawComment.body.length > this.maxCommentLength) shouldDiscard = true;

        // If user has been marked as not relevant
        if (this.trainingNotRelevant) {
            const notRelUserIndex = this.trainingNotRelevant.users.findIndex((thisUser) => thisUser.username === rawComment.author.name);
            if (notRelUserIndex !== -1) {
                shouldDiscard = true;
                console.log(`Comment discarded for not relevant user: ${rawComment.author.name}`);
            }
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

    newCommentEntity(initial = {}) { // Must provide body
        // returns an initial state for a new comment object
        return {
            id: uuidv4(),
            body: initial.body || null,
            author: initial.author || {name: null},
            words: [], // array of wordRef objects { word: 'word_seq' (also redis key to word object "word:word_seq"), hasSymbols: ['symbolKey', 'symbol:stock:gme', etc] }
            createdUtc: initial.createdUtc || Date.now(), // when the comment was posted (ms)
            foundAt: initial.foundAt || Date.now(), // when the comment registered to hashHype
            points: {
                '1Hr': {}, // {foo_bar: 342, other_word: etc...}
                '12Hr': {},
                '24Hr': {},
            },
            totalPoints: { // summed totals from the above points attr.
                '1Hr': 0,
                '12Hr': 0,
                '24Hr': 0,
            }
        }
    }
}



const thisReddit = new Reddit();
export default Reddit;
