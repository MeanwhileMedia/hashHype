import yargs from 'yargs';
import { ETwitterStreamEvent, TweetStream, TwitterApi, ETwitterApiError } from 'twitter-api-v2';
import RedisClient from '../utils/redisClient.js';

const argv = yargs(process.argv.slice(2)).argv;

// This class should be run independenly in it's own node.js process. It is the most basic implementation
// of simply pulling neww comments from a twitter stream, then immediately saving them, unparsed, to redis.
// The other processes will seperately grab from redis for language processing.
class FetchTwitterComments {
    constructor() {
        //This process keeps track of which comments were recently fetched it doesn't store duplicates to redis.
        this.recentCommentRecordMaxLength = 50;
        this.recentCommentRecord = [];

        const self = this;
        self.initRedisClient(() => {
            self.syncTrainingNotRelevant();
            self.createNewApiClient();
            // JWW stopping init stream connection
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

    createNewApiClient() {
        // JWW stopping
    }

    storeCommentsToRedis(commentObjects) { // JWW stopping implement
        const self = this;
        console.log(`Now storing ${commentObjects.length} comments to redis...`);
        commentObjects.forEach((comment) => {
            self.redisClient.set(`rawComment:${comment.id}`, comment);
        });
    }

    isDupComment(rawComment) { // JWW stopping implement
        if (this.recentCommentRecord.indexOf(rawComment.id) !== -1) return true;
        this.recentCommentRecord.unshift(rawComment.id);
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
            console.warn(`Comment will be discarded because it was in all caps. body:`, rawComment.body)
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
