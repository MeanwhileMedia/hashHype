import util from 'util';
import { throttle } from 'throttle-debounce';
import yargs from 'yargs';
import { std, mean } from 'mathjs';
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
        this.totalRankPlaces = 20; // IMPORTANT keep this synced with topCommentStats.minTopCommentsPerSymbolType. How many comments are held in topCommentStats.comments for each symbol type
        // end settings

        this.topTrendsStatsKey = 'stats:topTrends'; // The resulting computed data produced by this process
        this.topCommentsStatsKey = 'stats:topComments'; // this process listens for changes to this object in initKeyspaceSubscriptions. It only needs the min version. The non min is huge and holds data only needed by topCommentStats process.
        this.topCommentsStatsSnapshotIndexKey = `index:snapshotTstamps:${this.topCommentsStatsKey}`;

        // this.topTrends = this.newTopTrendsEntity();

        this.computeNewTopTrendsStatsThrottleTime = 60000*10; //ms - only run the heavy compute tasks once per this time interval
        this.throttle = {
            computeNewTopTrendsStats: throttle(this.computeNewTopTrendsStatsThrottleTime, this.computeNewTopTrendsStats).bind(this),
        };

        console.log('A new topTrendStats process has just started...');
        this.redisClient = null;
        this.levelDbClient = null;
        self.initRedisClient(() => {
            self.initLevelDbClient(() => {
                self.initKeyspaceSubscriptions();
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        this.redisClient = new RedisClient({
            onConnect: (client) => {
                console.log('Connected to locally hosted redis DBs for topTrendStats class.');
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

        self.getAllTopCommentStatsSnapshots((topCommentStatsSnapshots) => {
            const topTrends = self.newTopTrendsEntity();
            self.computeAllTrendHistories(topCommentStatsSnapshots, topTrends, () => {
                console.log(`Completed computeNewTopTrendsStats for ${topTrends.trends.length} trends.`); //:`, util.inspect(topTrends, {depth: 5, colors: true}));
                self.redisClient.set(self.topTrendsStatsKey, topTrends);
            });
        });
    }

    getAllTopCommentStatsSnapshots(cback) {
        const self = this;
        self.levelDbClient.get(this.topCommentsStatsSnapshotIndexKey, (snapshotTstampIndex) => {
            if (!snapshotTstampIndex) {
                console.warn(`Can't getAllTopCommentStatsSnapshots because no snapshot index was found in levelDB.`);
                if (cback) cback(null);
                return;
            }

            snapshotTstampIndex.reverse(); // in levelDB snapshotTstampIndex is sorted chronologically ascending. We will reverse to descending (newest first) right now.

            // Look at snapshotTstampIndex and loop through it, extracting only the tstamps that match our settings self.rankHistoryTstampInterval and self.rankHistoryTotalDuration
            const allTargetSnapshotTstamps = [];

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
                    allTargetSnapshotTstamps.push(thisSnapTstamp);
                    curSearchingForTstamp = curSearchingForTstamp - self.rankHistoryTstampInterval;
                }
            });
            console.log(`Will now attempt to get ${allTargetSnapshotTstamps.length} ${self.topCommentsStatsKey} snapshots from levelDB...`);

            const snapshotGetPromises = []; // array of arrays [[snapshotTStamp, topCommentsStatsObj], [1644086644348, topCommentsStatsObj], etc...]
            allTargetSnapshotTstamps.forEach((thisSnapTstamp, thisRankHistoryIndex) => {
                snapshotGetPromises.push(new Promise( (resolve, reject) => {
                    const snapShotKey = `${self.topCommentsStatsKey}:${thisSnapTstamp}`;
                    self.levelDbClient.get(snapShotKey, (thisTopCommentsSnapshot) => {
                        if (!thisTopCommentsSnapshot) {
                            console.warn(`getAllTopCommentStatsSnapshots could not find ${snapShotKey} snapshot.`);
                            allTargetSnapshotTstamps.splice(thisRankHistoryIndex, 1);
                            resolve([thisSnapTstamp, null]);
                            return;
                        }
                        self.checkSnapshotFormat(thisTopCommentsSnapshot);
                        resolve([thisSnapTstamp, thisTopCommentsSnapshot]);
                    });
                }));

            }); //end allTargetSnapshotTstamps.forEach

            Promise.all(snapshotGetPromises).then((gotSnapshots) => {
                console.log(`Found ${gotSnapshots.length} ${self.topCommentsStatsKey} snapshots. Expected ${self.rankHistoryTotalDuration/self.rankHistoryTstampInterval}.`);
                if (cback) cback(gotSnapshots);
            });
        }); //end self.levelDbClient.get(this.topCommentsStatsSnapshotIndexKey
    } // end getAllTopCommentStatsSnapshots

    checkSnapshotFormat(snapshot, snapshotKey) { // alters snapshot in-place
        // This function has manually hardcoded logic to support any/all old versions of a snapshot. If a snapshot is found to have a outdated data structure,
        // then this function will correct it on-the-fly. This is a workaround to make sure this process doesn't break on very old historical data.
        if (snapshotKey === this.topCommentsStatsKey) {
            if (Array.isArray(snapshot.comments)) {
                // topCommentStats.comments used to be a flat array. It was changed 3/11/22 to be an object keyed by symbol type: {stock: [comment8, comment3], coin: [etc..], etc..}
                // Back then, we were only storing topComments that had stock symbols.
                snapshot.comments = {stock: snapshot.comments};
            }
        }
    }

    computeAllTrendHistories(topCommentStatsSnapshots, topTrends, cback) { // updates topTrends.trends in-place
        // topCommentStatsSnapshots is array of arrays [[snapshotTStamp, topCommentsStatsObj], [1644086644348, topCommentsStatsObj], etc...]
        const self = this;
        self.redisClient.get(self.topCommentsStatsKey, (topCommentsStatsObj) => {
            // topCommentsStatsObj.comments.forEach((thisTopComment) => {
            for (const [symbolTypeGroup, theseTopComments] of Object.entries(topCommentsStatsObj.comments)) {
                theseTopComments.forEach((thisTopComment) => {
                    if (self.topTrendsMustHaveSymbol && !thisTopComment.topSymbolHigh['1Hr']) return;

                    const topSymbol = thisTopComment.symbols.find((symbol) => {
                        return symbolModel.generateRedisKey(symbol) === thisTopComment.topSymbolHigh['1Hr'];
                    });
                    if (!topSymbol) return;

                    const thisTrend = trendModel.createTrendObject({
                        word: topSymbol.symbol,
                        symbolKey: thisTopComment.topSymbolHigh['1Hr'],
                        symbolType: symbolTypeGroup,
                        rank: thisTopComment.rank,
                        histDur: self.rankHistoryTotalDuration
                    });

                    const rankHistory = [];
                    topCommentStatsSnapshots.forEach((thisTopCommentStatsSnapshot) => {
                        if (!thisTopCommentStatsSnapshot || !thisTopCommentStatsSnapshot[1] || !thisTopCommentStatsSnapshot[1].comments[symbolTypeGroup]) return;

                        const thisRankHistoryRecord = [thisTopCommentStatsSnapshot[0], null];
                        thisTopCommentStatsSnapshot[1].comments[symbolTypeGroup].some((thisTopComment, thisTopCommentIndex) => {
                            if (self.topTrendsMustHaveSymbol && !thisTopComment.topSymbolHigh['1Hr']) return;
                            const topSymbol = thisTopComment.symbols.find((symbol) => {
                                return symbolModel.generateRedisKey(symbol) === thisTopComment.topSymbolHigh['1Hr'];
                            });
                            if (topSymbol && topSymbol.symbol === thisTrend.word) {
                                thisRankHistoryRecord[1] = thisTopComment.rank;
                                return true; // found matching comment. break loop
                            }
                        });

                        rankHistory.push(thisRankHistoryRecord);
                    });

                    // 1. We persist the rankHistory on the trend object, saved to db.
                    thisTrend.rankHistory = rankHistory;

                    // 2. Use the rankHistory to determine the 'volatility' prop. int 0-1.
                    self.computeTrendVolatility(thisTrend); // alters thisTrend in-place

                    // 3. Combine above props to determine the 'decay' prop. in 0-1
                    self.computeTrendDecay(thisTrend); // alters thisTrend in-place

                    // We have now set all trend props which are related to historical data. Update topTrends.trends in-place
                    topTrends.trends.push(thisTrend);
                }); // end theseTopComments.forEach
            } // end for (const [symbolTypeGroup, theseTopComments]

            if (cback) cback();
        }); // end self.redisClient.get(self.topCommentsStatsKey
    } // end computeAllTrendHistories

    computeTrendVolatility(trend) { // alters trend in-place
        const self = this;
        // Use the trends rankHistory to determine the 'volatility' prop. int 0-1.
        // Volatility of 1 means that this trend's rank has changed consistently with no reoccurance pattern detected. This implies that the trend is valuable.
        // Volatility of 0 means that this trend has been ranked the same over all history checked. This implies that even though this trend is consistently talked about, it has little value as a time based trend indicator.

        // historiesNotRankedCount is how many entries in rankHistory are null, or, in how many stats:topComments snapshats was this trend not present (not ranked).
        let historiesNotRankedCount = 0;

        // nullCountToSeparateRankClusters setting dictates how many "null" ratings in a row have to occur to isolate a "rank cluster" - or - a chunk of time where this trend held any rank.
        const nullCountToSeparateRankClusters = (self.rankHistoryTotalDuration * .006) / self.rankHistoryTstampInterval; // if self.rankHistoryTotalDuration is 1 week, .006 is approx 1hr.
        // rankClusterMaxLength is a way to manually set when a cluster should be forced to end. This is used to allow our cluster stdDev measurement to be more useful
        // in cases where a trend has super long clusters that could last over multiple days (because clusters are averaged before computing the stdDev across clusters).
        const rankClusterMaxLength = 43200000 / self.rankHistoryTstampInterval; // 43200000 is 12hrs. With a self.rankHistoryTstampInterval of 10mins, no rank cluster will be longer than 72 rankings.

        // consider rank history [[ 1644861000000, 8 ], [ 1644860400000, 9 ], [ 1644859800000, null ], [ 1644858600000, null ], [ 1644857400000, null ], [ 1644850200000, 13 ], [ 1644849600000, 12 ], [ 1644849600000, 7 ]]
        // rankClusters would become [[8,9], [13,12,7]] - BUT, only if nullCountToSeparateRankClusters is <= 3
        const rankClusters = [];
        let curNullCount = 0;
        let curRankCluster = [];
        trend.rankHistory.forEach((thisRankHistory) => {
            if (thisRankHistory[1] === null) {
                ++historiesNotRankedCount;
                ++curNullCount;
            } else {
                curRankCluster.push(thisRankHistory[1]);
                if (curNullCount >= nullCountToSeparateRankClusters) {
                    rankClusters.push(curRankCluster);
                    curRankCluster = [];
                }
                curNullCount = 0;
            }

            if (curRankCluster.length >= rankClusterMaxLength) {
                // console.warn(`Ending rank cluster of ${curRankCluster.length} length for trend ${trend.word}`);
                rankClusters.push(curRankCluster);
                curRankCluster = [];
                curNullCount = 0;
            }
        });
        if (curRankCluster.length) rankClusters.push(curRankCluster);
        trend.rankClusterCount = rankClusters.length; // we save this to DB for use later

        // Now compute the average rank of every cluster. We will use those averages to form a final standard deviation
        const rankClusterAvgs = [];
        rankClusters.forEach((thisRankCluster) => {
            rankClusterAvgs.push(mean(thisRankCluster));
        });
        let clusterRankStdDev = 0;
        if (rankClusterAvgs.length) clusterRankStdDev = Math.round(std(rankClusterAvgs)*1000)/1000;
        trend.rankClusterStdDev = clusterRankStdDev;

        const percOfTimeWasRanked = 1 - (historiesNotRankedCount / trend.rankHistory.length);
        const percUnusedStdDeviation = 1 - (clusterRankStdDev / (this.totalRankPlaces/2)); // if totalRankPlaces is 20, the maximum standard deviation is 10. percUnusedStdDeviation = 1 - what percentage of 10 is this trends own ranking stdDev.

        const volatility = 1 - (percOfTimeWasRanked * percUnusedStdDeviation);
        trend.volatility = Math.round(volatility*1000)/1000;
    }

    computeTrendDecay(trend) {
        // Determine the 'decay' prop, usable in different context. I.e. It can be a rank penalty, so
        // a decay of 0.6 on a trend who's points earned it 2nd rank, would be corrected to 14th rank. 2 - (this.totalRankPlaces * decay)

        // For now, we are only using the volatility prop to calculate decay, but the decay calcualtion may include other metrics later.
        trend.decay = 1 - trend.volatility; // for example, SPY had a low volatility of only .13 and therefore it's decay becomes .87. It would rightly take a big hit in rank because it's movement is stale.
    }

}

const thisTopTrendStats = new TopTrendStats();
export default TopTrendStats;
