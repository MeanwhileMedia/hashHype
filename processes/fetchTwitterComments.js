import util from 'util';
import yargs from 'yargs';
import { ETwitterStreamEvent, TweetStream, TwitterApi, ETwitterApiError } from 'twitter-api-v2';
import RedisClient from '../utils/redisClient.js';
import commentModel from '../utils/objectModels/comment.js';
import twitterClientConfig from '../utils/twitterClient-config.js';

const argv = yargs(process.argv.slice(2)).argv;

// This class should be run independenly in it's own node.js process. It is the most basic implementation
// of simply pulling neww comments from a twitter stream, then immediately saving them, unparsed, to redis.
// The other processes will seperately grab from redis for language processing.
class FetchTwitterComments {
    constructor() {
        const self = this;
        self.twitterApiClient = null;
        self.twitterApiClientStream = null;

        self.commentCountLastInterval = 0; // For logging our comment volume.]
        self.commentCountIntervalLength = 5000; // ms, how long should we count comments before we log the sum and restart. Set it to same as reddit fetchLoopIntervalTime for easy volume comparison.
        self.commentCountInterval = null;
        self.initCommentCountInterval();

        //This process keeps track of which comments were recently fetched it doesn't store duplicates to redis.
        self.recentCommentRecordMaxLength = 200;
        self.recentCommentRecord = [];

        console.log('A new fetchTwitterComments process has just started...');
        self.initRedisClient(() => {
            self.syncTrainingNotRelevant();
            self.createNewApiClient(() => {
                self.initTwitterSampleStream(() => {
                    self.initTwitterSampleStreamListeners();
                });
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        this.redisClient = new RedisClient({
            onConnect: () => {
                console.log('Connected to locally hosted redis DBs for topCommentStats class.');
                if (cback) cback();
            }
        });
    }

    createNewApiClient(cback) {
        this.twitterApiClient = new TwitterApi(twitterClientConfig.bearerToken);
        if (cback) cback();
    }

    initTwitterSampleStream(cback) {
        this.twitterApiClientStream = this.twitterApiClient.v2.sampleStream({
            autoConnect: false,
            'expansions': ['author_id'], //['author_id', 'attachments.media_keys'],
            'tweet.fields': ['created_at', 'lang'],
            'user.fields': ['username'],
            // 'media.fields': ['type', 'url', 'preview_image_url']
        });
        this.twitterApiClientStream.on(ETwitterStreamEvent.Connected, () => {
            console.log('Twitter sample stream is connected...');
            if (cback) cback();
        });
        this.twitterApiClientStream.on(ETwitterStreamEvent.ConnectionError, (err) => {
            console.error('Twitter sample stream connection error:', err);
        });
        this.twitterApiClientStream.on(ETwitterStreamEvent.ConnectionClosed, (err) => {
            console.log('Twitter sample stream connection was closed.', err);
        });
        this.twitterApiClientStream.on(ETwitterStreamEvent.Error, (err) => {
            console.error('Twitter sample stream error:', util.inspect(err, {depth: 5, colors: true}));
        });
        this.twitterApiClientStream.connect({ autoReconnect: true, autoReconnectRetries: Infinity });
    }

    initTwitterSampleStreamListeners() {
        // Emitted on Tweet
        const self = this;
        self.twitterApiClientStream.on(ETwitterStreamEvent.Data, (data) => {
            //console.log('New tweet: ', util.inspect(data, {depth: 5, colors: true}));
            if (!data ||
                !data.data ||
                !data.data.id ||
                !data.data.lang ||
                !data.data.text ||
                !data.data.author_id ||
                !data.data.created_at ||
                !data.includes ||
                !data.includes.users
            ) {
                console.warn(`Incomplete tweet data will be discarded:`, util.inspect(data, {depth: 5, colors: true}));
            }

            // We currently only process english tweets
            if (data.data.lang !== 'en') return; // && data.data.lang !== 'und') return; // 'und' - undetermined - is usually a tweet that is just a bunch of mentions or hashTags without actual wording.

            if (self.isDupComment(data.data.id)) return;

            const author = data.includes.users.find(user => user.id === data.data.author_id);
            if (!author) console.warn(`Could not identify author username on tweet. Will be discarded:`, util.inspect(data, {depth: 5, colors: true}));

            const rawComment = commentModel.createNewCommentObject({
                source: 'twitter_sampleStream',
                body: data.data.text, // we only use reddit's comment.body temporarily in our "isDiscardComment" function below. This gets reset in the extractWordsFromComments process from a parsed/sanitized originalBody.
                originalBody: data.data.text,
                author: {name: author.username},
                createdUtc: new Date(data.data.created_at).getTime(),
                // wordAssocs: wordAssocs
            });

            if (self.isDiscardComment(rawComment)) return;

            self.storeCommentToRedis(rawComment);
        });
    }

    storeCommentToRedis(rawComment) {
        const self = this;
        self.redisClient.set(`rawComment:${rawComment.id}`, rawComment);
        ++self.commentCountLastInterval;
    }

    initCommentCountInterval() {
        const self = this;
        if (self.commentCountInterval) return;
        self.commentCountInterval = setInterval(() => {
            console.log(`Stored ${self.commentCountLastInterval} twitter comments in the last ${self.commentCountIntervalLength/1000} seconds.`);
            self.commentCountLastInterval = 0;
        }, self.commentCountIntervalLength);
    }

    isDupComment(twitterCommentId) {
        if (this.recentCommentRecord.indexOf(twitterCommentId) !== -1) {
            console.warn(`Comment with twitter ID ${twitterCommentId} was already stored. Will discard dup.`);
            return true;
        }
        this.recentCommentRecord.unshift(twitterCommentId);
        this.recentCommentRecord = this.recentCommentRecord.slice(0, this.recentCommentRecordMaxLength);
        return false;
    }

    isDiscardComment(rawComment) { // JWW TODO implement
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

        // 3. HashHype has a "no all-caps" rule. These comments will often trigger false positive symbol matches (because stock/coin symbols are expected to be in all caps).
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


const twitter = new FetchTwitterComments();
export default FetchTwitterComments;
