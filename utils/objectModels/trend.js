// A 'trend' object represents when a symbol word was topSymbolHigh in one of the comments which ranked within topCommentStats. These objects are
// instantiated by topTrendStats and saved in a ranked list within stats:topTrends in real time (and are ALSO snapshotted into historical DB).
const trendObjModel = {

    createTrendObject: function(props = {}) {

        if (!props.word) {
            console.error(`Must provide word prop when instantiating a new trend object. Props received:`, props);
            return null;
        }
        if (!props.rank) {
            console.error(`Must provide rank prop when instantiating a new trend object. Props received:`, props);
            return null;
        }

        const trendObj = {
            class: 'trend',
            trendSrc: props.trendSrc || 'stats:topComments', // the absKey to the redis object which originally surfaced this trend.
            word: props.word || null, // the word string that represents this trene. i.e: GME_!!_moon_!!_today

            symbolKey: props.symbolKey || null, // the absKey to the symbol that this trend is represented by
            symbolType: props.symbolType || null,

            rank: props.rank || null, // this trend's current position within trendSrc (where 1st rank is the trend which represents the 1st ranked comment within topCommentStats.comments)

            // histDur is the window of time in which the below historical data was calculated. See topTrendStats.rankHistoryTotalDuration
            histDur: props.histDur || 0, // int (ms)

            // rankHistory is an interval based history of what rank this trend held (if any) within topTrendStats. The length and interval frequency of this array is limited by
            // settings within topTrendStats.js (rankHistoryMaxLength). This record is periodically computed by topTrendStats.js by looping through our historical archive snapshots of stats:topComments.
            rankHistory: props.rankHistory || [], // [[intervalTStamp, rank int], [1644086644348, 1], [1644086645348, null], etc...]

            // rankClusterCount is a record of how many "rank clusters" were found when computing volatility (groups of rankings within rankHistory). See topTrendStats nullCountToSeparateRankClusters.
            rankClusterCount: props.rankClusterCount || 0, // int

            // rankClusterStdDev is another computation by topTrendStats that we persist to DB. It is the measure of standard deviation between ranks held in rankHistory. A high standard deviation will result in a higher volatility rating.
            rankClusterStdDev: props.rankClusterCount || 0, // int

            // volatility is a measure of how much this trend's rank changes over time. A low volatility shows that this trend stays consistently in the same rank (or near the same rank)
            // over the period in time held in rankHistory. volatility is a key factor in calculating decay. A trend that shows little movement will earn a higher decay rating, and will be excluded from UI (even if it is consistently ranked high)
            volatility: props.volatility || 0, // int between 0 and 1.

            // decay is a measure of what degree of significance this trend has lost over the time represented inside rankHistory. The higher the number, the less signicant this trend is (with a decay
            // of 1 suggesting this trend is basically irrelevant). This is calculated in topTrendStats.js, and is based multiple factors. I.e: a trend starts to decay if it's ranking is too consistent over time (low volatility).
            decay: props.decay || 0, // int between 0 and 1.

        }

        return trendObj;
    }

}; // end trendObjModel


export default trendObjModel;
