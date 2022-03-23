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
        self.recentCommentRecordMaxLength = 1000;
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
            'expansions': ['author_id', 'referenced_tweets.id'], //['author_id', 'attachments.media_keys'],
            'tweet.fields': ['created_at', 'lang', 'referenced_tweets'],
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

            // console.log('New tweet:', util.inspect(data, {depth: 5, colors: true}));
            // See bottom of this file for sample tweet data format

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

            if (data.data.referenced_tweets && data.data.referenced_tweets.length) {
                self.extendRetweetedText(data, rawComment) // alters rawComment in-place
            }

            if (self.isDiscardComment(rawComment)) return;

            self.storeCommentToRedis(rawComment);
        });
    } // end initTwitterSampleStreamListeners

    extendRetweetedText(data, rawComment) { // alters rawComment in-place
        // If this is a retweet, twitter will have sent us the shortened (140 chars) text in data.data.text. Since we want the full thing,
        // we will look at data.includes.tweets, locate the text from the retweeted tweet, then replace data.data.text with the full text.
        if (!data.data.referenced_tweets) return;
        let retweetedId = data.data.referenced_tweets.find((thisRefTweet) => thisRefTweet.type === 'retweeted');
        if (!retweetedId || !data.includes.tweets || !data.includes.tweets.length) return;
        if (!data.includes.users || !data.includes.users.length) return;

        retweetedId = retweetedId.id;
        const retweeted = data.includes.tweets.find((thisIncTweet) => thisIncTweet.id === retweetedId);
        if (!retweeted) return;

        // We don't want to lose the initial "RT @user:" data, but we also don't want it to be hardcoded to comment body. Assign the quoted username to our comment object.
        // 'RT @HemantBishnoi: BlackBulbul #birding #birdphotography #BirdsSeenIn2022 #birds #natgeo #bbcearth #nikonphotography #Nikon #strabopixelclu…'
        // becomes
        // 'BlackBulbul #birding #birdphotography #BirdsSeenIn2022 #birds #natgeo #bbcearth #nikonphotography #Nikon #strabopixelclub #wildlife #TwitterNatureCommunity #BBCWildlifePOTD #camera #NatureBeauty #NaturePhotography #TwitterNatureCommunity #NatureLovers #IndiAves #NikonD850 #bird https://t.co/s4IOLs133y'
        // and
        // rawComment.quotedAuthor.name == 'HemantBishnoi'
        const quotedAuthor = data.includes.users.find((thisUser) => thisUser.id === retweeted.author_id);
        rawComment.body = retweeted.text;
        rawComment.originalBody = retweeted.text;
        rawComment.isQuoted = true;
        rawComment.quotedAuthor = {name: quotedAuthor.username};
    } // end extendRetweetedText

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


// Sample tweet data format:
// {
//     data: {
//         author_id: '1302522113866203137',
//         created_at: '2022-03-23T16:04:23.000Z',
//         id: '1506663156705337353',
//         lang: 'en',
//         referenced_tweets: [ { type: 'retweeted', id: '1506644615352533002' } ],
//         text: 'RT @Mztiifaah: Naija hood rep reality show is starting by the 27th of March and I can’t help but anticipate ��the struggle to win the grand…'
//     },
//     includes: {
//         users: [
//             {
//                 id: '1302522113866203137',
//                 name: 'Psycho ���' ,
//                 username: 'wtfbangz'
//             },
//             {
//                 id: '792833491578880000',
//                 name: 'INNOCENT SINNER ��'  ,
//                 username: 'Mztiifaah'
//             }
//         ],
//         tweets: [
//             {
//                 author_id: '792833491578880000',
//                 created_at: '2022-03-23T14:50:43.000Z',
//                 id: '1506644615352533002',
//                 lang: 'en',
//                 text: 'Naija hood rep reality show is starting by the 27th of March and I can’t help but anticipate ��th e struggle to win the grand prize of 35M and a brand new car among 21 housemates is gon be mad fun\n' +
//                 'I’m really excited about this one �� @naijahoodrep \n' +
//                 '#BackToBase https://t.co/ftjrB5w6Dy'
//             }
//         ]
//     }
// }
