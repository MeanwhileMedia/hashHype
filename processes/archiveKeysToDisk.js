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

        self.lastSnapshotTstamp = null;
        self.redisKeyspaceSubscriptions = { // obj where key defines specific redis key to be transferred to long term archive, and where value is the function run for each redis change message for that key.

            '__keyspace@0__:stats:topComments': {
                snapshotTstampInterval: 10000, // how long between each snapshot. The snapshot tstamps are generated as denominations of this num.
                genTstamp: () => {
                    // Each redis key that is defined here (to be snapshotted to levelDB) is saved to archive key ${objectKey}:${tstampRoundedToDenomination}
                    // 'stats:topComments' has snapshots saved in 10s denominations
                    const now = Date.now();
                    const thisTstamp = now - (now % self.redisKeyspaceSubscriptions['__keyspace@0__:stats:topComments'].snapshotTstampInterval);

                    this.lastUsedTstamp = this.lastUsedTstamp || 0;
                    if (thisTstamp === this.lastUsedTstamp) return null;
                    this.lastUsedTstamp = thisTstamp;
                    return thisTstamp;
                },
                action: () => {
                    const thisRedisObjKey = 'stats:topComments';
                    const thisTstamp = self.redisKeyspaceSubscriptions['__keyspace@0__:stats:topComments'].genTstamp();
                    if (!thisTstamp) return;
                    const levelDBArchiveKey = `${thisRedisObjKey}:${thisTstamp}`;
                    self.redisClient.get(thisRedisObjKey, (topCommentsObj) => {
                        self.levelDbClient.set(levelDBArchiveKey, topCommentsObj, (success) => {
                            if (!success) {
                                console.error(`Failed to snapshot a key to levelDB archive (${levelDBArchiveKey})`);
                                return;
                            }
                            console.log(`Saved new ${levelDBArchiveKey} snapshot to key archive DB.`);
                            self.saveTstampToIndex(thisRedisObjKey, thisTstamp);
                        });
                    });
                }
            }, // end '__keyspace@0__:stats:topComments'

            // '__keyspace@0__:stats:topTrends': { // JWW TODO - if we find a need to archive stats:topTrends, levelDB client DB eviction logic will need to be updated. See "diskCheckCorrectionDeletesArchivedKey"
            //     snapshotTstampInterval: 10000, // how long between each snapshot. The snapshot tstamps are generated as denominations of this num.
            //     genTstamp: () => {
            //         // Each redis key that is defined here (to be snapshotted to levelDB) is saved to archive key ${objectKey}:${tstampRoundedToDenomination}
            //         // 'stats:topComments' has snapshots saved in 10s denominations
            //         const now = Date.now();
            //         const thisTstamp = now - (now % self.redisKeyspaceSubscriptions['__keyspace@0__:stats:topTrends'].snapshotTstampInterval);
            //
            //         this.lastUsedTstamp = this.lastUsedTstamp || 0;
            //         if (thisTstamp === this.lastUsedTstamp) return null;
            //         this.lastUsedTstamp = thisTstamp;
            //         return thisTstamp;
            //     },
            //     action: () => {
            //         const thisRedisObjKey = 'stats:topTrends';
            //         const thisTstamp = self.redisKeyspaceSubscriptions['__keyspace@0__:stats:topTrends'].genTstamp();
            //         if (!thisTstamp) return;
            //         const levelDBArchiveKey = `${thisRedisObjKey}:${thisTstamp}`;
            //         self.redisClient.get(thisRedisObjKey, (topTrendsObj) => {
            //             self.levelDbClient.set(levelDBArchiveKey, topTrendsObj, (success) => {
            //                 if (!success) {
            //                     console.error(`Failed to snapshot a key to levelDB archive (${levelDBArchiveKey})`);
            //                     return;
            //                 }
            //                 console.log(`Saved new ${levelDBArchiveKey} snapshot to key archive DB.`);
            //                 self.saveTstampToIndex(thisRedisObjKey, thisTstamp);
            //             });
            //         });
            //     }
            // } // end '__keyspace@0__:stats:topTrends'

        };

        self.changeEventThrottle = 5000; //ms, maximum for how often this process will run redisKeyspaceSubscriptions actions on any given channel
        self.changeEventTstamps = {}; // a record used below in subscribeToRedisKeyspaceEvents when determining if our changeEventThrottle time has elapsed yet.

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
                console.log('Connected new redis sub client for ArchiveKeysToDisk class.');
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

    saveTstampToIndex(thisArchivedObjKey, tstamp, cback) {
        // We must also save all archive snapshot tstamps to the index:snapshotTstamps:${redisObjectKey} object which is used later as a record of all snapshot tstamps so they can
        // be easily browsed, or deleted later (if the archive DB gets to big). Sorted chronologically ascending
        const self = this;
        const tstampIndexKey = `index:snapshotTstamps:${thisArchivedObjKey}`;
        self.levelDbClient.get(tstampIndexKey, (archiveIndex) => { // archiveIndex is array
            if (!archiveIndex) archiveIndex = [];
            archiveIndex.push(tstamp);
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

}

const thisArchiveKeysToDisk = new ArchiveKeysToDisk();
export default ArchiveKeysToDisk;
