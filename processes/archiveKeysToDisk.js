import path from 'path';
import yargs from 'yargs';
import RedisClient from '../utils/redisClient.js';
import LevelDBClient from '../utils/levelDBClient.js';

const argv = yargs(process.argv.slice(2)).argv;

// This class listens to specified redis keyspace events and saves timestamped snapshots of those keys to levelDB,
// a disk based key-value store. It was chosen to be our long term storage DB because we need a lot of space,
// and definitely don't want to hold it in RAM (like redis). LevelDB offers simplicity, minimal DB size on disk, but slow read/write.
class ArchiveKeysToDisk {
    constructor() {
        const self = this;

        self.redisClient = null;
        self.levelDbClient = null;

        self.topCommentsStatsMinKey = 'stats:topComments'; // this process will only snapshot the min version because the full version is massive and holds data only needed by topCommentStats

        self.lastSnapshotTstamp = null;
        self.redisKeyspaceSubscriptions = { // obj where key defines specific redis key to be transferred to long term archive, and where value is the function run for each redis change message for that key.

            '__keyspace@0__:stats:topComments': {
                snapshotTstampInterval: 10000, // how long between each snapshot. The snapshot tstamps are generated as denominations of this num.
                genTstamp: () => {
                    // Each redis key that is defined here (to be snapshotted to levelDB) is saved to archive key ${objectKey}:${tstampRoundedToDenomination}
                    // 'stats:topComments' has snapshots saved in 10s denominations
                    const now = Date.now();
                    const thisTstamp = now - (now % self.redisKeyspaceSubscriptions[`__keyspace@0__:${self.topCommentsStatsMinKey}`].snapshotTstampInterval);

                    this.lastUsedTstamp = this.lastUsedTstamp || 0;
                    if (thisTstamp === this.lastUsedTstamp) return null;
                    this.lastUsedTstamp = thisTstamp;
                    return thisTstamp;
                },
                action: () => {
                    const thisRedisObjKey = self.topCommentsStatsMinKey;
                    const thisTstamp = self.redisKeyspaceSubscriptions[`__keyspace@0__:${self.topCommentsStatsMinKey}`].genTstamp();
                    if (!thisTstamp) return;
                    const levelDBArchiveKey = `${thisRedisObjKey}:${thisTstamp}`;
                    self.redisClient.get(thisRedisObjKey, (topCommentsObj) => {
                        //loadTestDb(thisRedisObjKey, topCommentsObj);
                        self.levelDbClient.set(levelDBArchiveKey, topCommentsObj, (success) => {
                            if (!success) {
                                console.error(`Failed to snapshot a key to levelDB archive (${levelDBArchiveKey})`);
                                return;
                            }
                            console.log(`Saved new ${levelDBArchiveKey} snapshot to key archive DB.`);
                            self.saveTstampsToIndex(thisRedisObjKey, [thisTstamp]);
                        });
                    });
                }
            }, // end `__keyspace@0__:${self.topCommentsStatsMinKey}`: {

        };

        self.changeEventThrottle = 5000; //ms, maximum for how often this process will run redisKeyspaceSubscriptions actions on any given channel
        self.changeEventTstamps = {}; // a record used below in subscribeToRedisKeyspaceEvents when determining if our changeEventThrottle time has elapsed yet.

        console.log('A new archiveKeysToDisk process has just started...');
        self.initRedisClient(() => {
            self.initLevelDbClient(() => {
                self.subscribeToRedisKeyspaceEvents();
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        self.redisClient = new RedisClient({
            onConnect: () => {
                console.log('Connected to locally hosted redis DBs for ArchiveKeysToDisk class.');
                if(cback) cback();
            }
        });
    }

    initLevelDbClient(cback) {
        const self = this;
        self.levelDbClient = new LevelDBClient({
            redisClient: self.redisClient,
            onConnect: () => {
                console.log('Connected new levelDB client for ArchiveKeysToDisk class.');
                if(cback) cback();
            }
        });
    }

    subscribeToRedisKeyspaceEvents() {
        const self = this;

        // 1. Register all of our pubsub keyspace channels for which we seek message events.
        for (let [thisRedisKeyspaceChannel, thisKeyspaceAction] of Object.entries(self.redisKeyspaceSubscriptions)) {
            console.log(`Subscribing to keyspace changes on channel: ${thisRedisKeyspaceChannel}`);
            self.redisClient.subscribe(thisRedisKeyspaceChannel);
            self.saveObjKeyToIndex(thisRedisKeyspaceChannel.split(':').slice(1).join(':'));
        }

        self.redisClient.on('message', (channel, action) => {
            if (action !== 'set') return; // we currently only support emitting changes due to string set commands because archive only stores strings
            if (!self.redisKeyspaceSubscriptions[channel]) return;

            // Throttle how often we will act on this change event. To save on resources.
            const now = Date.now();
            if (!self.changeEventTstamps[channel]) self.changeEventTstamps[channel] = now;
            if (self.changeEventTstamps[channel] + self.changeEventThrottle > now) return;
            self.changeEventTstamps[channel] = now;

            self.redisKeyspaceSubscriptions[channel].action();
        });
    }

    saveTstampsToIndex(thisArchivedObjKey, tstamps = [], cback) {
        // We must also save all archive snapshot tstamps to the index:snapshotTstamps:${redisObjectKey} object which is used later as a record of all snapshot tstamps so they can
        // be easily browsed, or deleted later (if the archive DB gets to big). Sorted chronologically ascending
        const self = this;
        const tstampIndexKey = `index:snapshotTstamps:${thisArchivedObjKey}`;
        self.levelDbClient.get(tstampIndexKey, (archiveIndex) => { // archiveIndex is array
            if (!archiveIndex) archiveIndex = [];
            archiveIndex = archiveIndex.concat(tstamps);
            // console.log(`${tstampIndexKey.split(':').slice(2).join(':')} has been archived to LevelDb ${archiveIndex.length} times:`, archiveIndex);
            self.levelDbClient.set(tstampIndexKey, archiveIndex, (success) => {
                if (!success) console.warn(`Failed to set ${tstampIndexKey} to levelDB.`);
                if (cback) cback(success);
            });
        });
    }

    saveObjKeyToIndex(thisArchivedObjKey, cback) {
        // We also save an index of all the redis object keys which are being snapshotted to our levelDB archive. This can be used to browse available snapshots, and look
        // up `index:snapshotTstamps:${thisArchivedObjKey}` arrays.
        const self = this;
        const indexKey = `index:snapshotObjKeys`;
        self.levelDbClient.get(indexKey, (snapshotObjKeys) => { // snapshotObjKeys is array
            if (!snapshotObjKeys) snapshotObjKeys = [];
            if (snapshotObjKeys.indexOf(thisArchivedObjKey) !== -1) {
                if (cback) cback();
                return;
            }
            snapshotObjKeys.push(thisArchivedObjKey);
            console.log(`${thisArchivedObjKey} has been added to LevelDb ${indexKey}. All redis objects being snapshotted:`, snapshotObjKeys);
            self.levelDbClient.set(indexKey, snapshotObjKeys, (success) => {
                if (!success) {
                    console.error(`Failed to set ${indexKey}`, err);
                }
                if (cback) cback();
            });
        });
    }

    loadTestDb(objKey, sampleDataOb) {
        const jwwFillDb = (count = 0) => {
            const fillBatchSize = 100;
            self.isFilling = true;
            let thisRoundCount = 0;
            const now = Date.now()
            count = count + fillBatchSize;
            if (count >= 10000) {
                self.isFilling = false;
                return;
            }
            if (count % 100 === 0) console.log('Current fake object set count:', count);
            let thisRoundCompleteCount = 0;
            const thisRoundTstamps = [];
            while (thisRoundCount < fillBatchSize) {
                ++thisRoundCount;
                const thisTstamp = now+thisRoundCount;
                thisRoundTstamps.push(thisTstamp);
                const thisKey = `${objKey}:${thisTstamp}`;
                self.levelDbClient.set(thisKey, sampleDataOb, (success) => {
                    ++thisRoundCompleteCount;
                    if (thisRoundCompleteCount >= fillBatchSize) {
                        self.saveTstampsToIndex(objKey, thisRoundTstamps, () => {
                            jwwFillDb(count)
                        });
                    }
                });
            }
        }
        if (!self.isFilling) {
            console.warn(`Will now fill rocksDB with 10000 more fake objects`);
            jwwFillDb();
        }
    }

}

const thisArchiveKeysToDisk = new ArchiveKeysToDisk();
export default ArchiveKeysToDisk;
