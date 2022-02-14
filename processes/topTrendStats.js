import util from 'util';
import { throttle } from 'throttle-debounce';
import yargs from 'yargs';
import RedisClient from '../utils/redisClient.js';
import LevelDBClient from '../utils/levelDBClient.js';
import trendModel from '../utils/objectModels/trend.js';
import symbolModel from '../utils/objectModels/symbol.js';

const argv = yargs(process.argv.slice(2)).argv;

class TopTrendStats {
    constructor() {
        const self = this;

        // process specific settings
        this.topTrendsMustHaveSymbol = true;
        this.rankHistoryTstampInterval = 60000*10; // ms, when generating rankHistory for a trend object, how long between each record. NOTE: MUST be greater than AND divisble by stats:topComments snapshotTstampInterval (see archiveKeysToDisk.js)
        this.rankHistoryTotalDuration = 604800000; // ms, what span of time is represented in rankHistory. 604800000 is one week.
        // end settings

        this.topTrendsStatsKey = 'stats:topTrends'; // The resulting computed data produced by this process
        this.topCommentsStatsKey = 'stats:topComments'; // this process listens for changes to this object in initKeyspaceSubscriptions
        this.topCommentsStatsSnapshotIndexKey = 'index:snapshotTstamps:stats:topComments';

        this.topTrends = this.newTopTrendsEntity();

        this.computeNewTopTrendsStatsThrottleTime = 60000*10; //ms - only run the heavy compute tasks once per this time interval
        this.throttle = {
            computeNewTopTrendsStats: throttle(this.computeNewTopTrendsStatsThrottleTime, this.computeNewTopTrendsStats).bind(this),
        };

        this.redisClient = null;
        this.levelDbClient = null;
        self.initRedisClient(() => {
            self.initLevelDbClient(() => {
                self.redisClient.get(self.topTrendsStatsKey, (topTrendsStatsObj) => {
                    if (topTrendsStatsObj) self.topTrends = topTrendsStatsObj;
                    self.initKeyspaceSubscriptions();
                });
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        this.redisClient = new RedisClient({
            onConnect: (client) => {
                console.log('Connected new redis sub client for topTrendStats class.');
                if(cback) cback();
            }
        });
    }

    initLevelDbClient(cback) {
        const self = this;
        self.levelDbClient = new LevelDBClient({
            redisClient: self.redisClient,
            onConnect: () => {
                console.log('Connected new levelDB client for topTrendStats class.');
                if(cback) cback();
            }
        });
    }

    initKeyspaceSubscriptions() {
        const self = this;
        self.redisClient.on('message', function (channel, message){ // If this event was sent as part of the set pattern subcribed keyspace event, then it's "patternWithKey" will be: __keyspace@0__:word:foo_!!_bar:foundAt
            self.throttle.computeNewTopTrendsStats();
        });
        self.redisClient.subscribe(`__keyspace@0__:${self.topCommentsStatsKey}`);
    }

    newTopTrendsEntity(initial = {}) {
        // returns an initial state for a top comment stats
        return {
            absKey: this.topTrendsStatsKey,
            trends: [],
        }
    }

    computeNewTopTrendsStats() {
        const self = this;
        console.log(`Now running computeNewTopTrendsStats...`);
        self.redisClient.get(self.topCommentsStatsKey, (topCommentsStatsObj) => {
            self.topTrends.trends = []; // reset so we can refill now
            topCommentsStatsObj.comments.forEach((thisTopComment, thisCommentIndex) => {
                if (self.topTrendsMustHaveSymbol && !thisTopComment.topSymbolHigh['1Hr']) return;

                const topSymbol = thisTopComment.symbols.find((symbol) => {
                    return symbolModel.generateRedisKey(symbol) === thisTopComment.topSymbolHigh['1Hr'];
                });

                const thisTrend = trendModel.createTrendObject({
                    word: topSymbol.symbol,
                    wordKey: `word:${topSymbol.symbol}`,
                    symbolKey: thisTopComment.topSymbolHigh['1Hr'],
                    rank: thisCommentIndex+1
                });


                self.computeRankHistory(thisTrend, (rankHistory) => {
                    thisTrend.rankHistory = rankHistory;
                    // JWW stopping point - generate volatility, and decay props

                    self.topTrends.trends.push(thisTrend);
                    console.log(self.topTrends)
                });



            });
        });
    }

    computeRankHistory(trend, cback) {
        const self = this;

        // JWW stopping now add the rank to each tstamp already in rankHistory array (levelDB snapshots)
        const rankHistory = [];
        self.levelDbClient.get(this.topCommentsStatsSnapshotIndexKey, (snapshotTstampIndex) => {
            if (!snapshotTstampIndex) {
                console.warn(`Can't compute rankHistory for trend ${trend.word} because no snapshot index was found in levelDB.`);
                if (cback) cback(null);
                return;
            }

            snapshotTstampIndex.reverse(); // snapshotTstampIndex is sorted chronologically ascending

            const now = Date.now();
            const oldestSearchingForTstamp = now - self.rankHistoryTotalDuration;
            let curSearchingForTstamp = now - (now % self.rankHistoryTstampInterval);
            snapshotTstampIndex.some((thisSnapTstamp) => {
                if (thisSnapTstamp < oldestSearchingForTstamp) {
                    return true; // we have all the tstamps we can get for our rankHistoryTotalDuration. Break loop.
                }
                if (thisSnapTstamp < curSearchingForTstamp) {
                    curSearchingForTstamp = curSearchingForTstamp - self.rankHistoryTstampInterval; // we could not find the last tstamp we were searching for. Skip to the next one.
                }
                if (thisSnapTstamp === curSearchingForTstamp) {
                    rankHistory.push([thisSnapTstamp]);
                    curSearchingForTstamp = curSearchingForTstamp - self.rankHistoryTstampInterval;
                }
            });
            console.log(`Will now attempt to get ${rankHistory.length} ${self.topCommentsStatsKey} snapshots from levelDB...`);

            const rankLookupPromises = [];
            rankHistory.forEach((thisRankHistory, thisRankHistoryIndex) => {
                const thisSnapTstamp = thisRankHistory[0];

                rankLookupPromises.push(new Promise( (resolve, reject) => {
                    const snapShotKey = `${self.topCommentsStatsKey}:${thisSnapTstamp}`;
                    self.levelDbClient.get(snapShotKey, (thisTopCommentsSnapshot) => {
                        if (!thisTopCommentsSnapshot) {
                            console.warn(`Could not find ${snapShotKey} snapshot. Will not include rank for trend ${trend.word} at that tstamp.`);
                            rankHistory.splice(thisRankHistoryIndex, 1);
                            resolve();
                            return;
                        }

                        thisRankHistory[1] = null;
                        thisTopCommentsSnapshot.comments.some((thisTopComment) => {
                            if (self.topTrendsMustHaveSymbol && !thisTopComment.topSymbolHigh['1Hr']) return;
                            const topSymbol = thisTopComment.symbols.find((symbol) => {
                                return symbolModel.generateRedisKey(symbol) === thisTopComment.topSymbolHigh['1Hr'];
                            });
                            if (topSymbol && topSymbol.symbol === trend.word) {
                                thisRankHistory[1] = thisTopComment.rank;
                                return true; // found matching comment. break loop
                            }
                        });
                        resolve();
                    });
                }));

            }); //end rankHistory.forEach

            Promise.all(rankLookupPromises).then(() => {
                console.log(`Found ${rankHistory.length} rank histories for trend ${trend.word}. Expected ${self.rankHistoryTotalDuration/self.rankHistoryTstampInterval}.`);
                if (cback) cback(rankHistory);
            });
        }); //end self.levelDbClient.get(this.topCommentsStatsSnapshotIndexKey

    } // end computeRankHistory

}

const thisTopTrendStats = new TopTrendStats();
export default TopTrendStats;
