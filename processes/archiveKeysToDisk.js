import path from 'path';
import yargs from 'yargs';
import level from 'level'; // https://github.com/Level/leveldown#api
import RedisClient from '../utils/redisClient.js';

const argv = yargs(process.argv.slice(2)).argv;

// This class listens to specified redis keyspace events and saves timestamped snapshots of those keys to levelDB,
// a disk based key-value store. It was chosen to be our long term storage DB because we need a lot of space,
// and definitely don't want to hold it in RAM (like redis). LevelDB offers simplicity, minimal DB size on disk, but slow read/write.
class ArchiveKeysToDisk {
    constructor() {
        const self = this;

        self.redisClient = null;
        self.levelDbClient = null; // DOES NOT automatically perform json stringify/parse during get/set like our redisClient.
        self.levelDbDir = path.resolve(process.cwd(), '..', 'hashHypeArchive'); // IMPORTANT - this directory must be above our main hashHype app directory or it will be nuked during our deploy process
        self.leveDbOptions = {}; // anything not defined here will inherit defaults through level

        self.lastSnapshotTstamp = null;
        self.redisKeyspaceSubscriptions = { // obj where key defines specific redis key to be transferred to long term archive, and where value is the function run for each redis change message for that key.

            '__keyspace@0__:stats:topComments': {
                genTstamp: () => {
                    // Each redis key that is defined here (to be snapshotted to levelDB) is saved to archive key ${objectKey}:${tstampRoundedToDenomination}
                    // 'stats:topComments' has snapshots saved in 5s denominations
                    const now = Date.now();
                    const thisTstamp = now - (now % 5000);

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
                        console.log(`Saving new ${levelDBArchiveKey} snapshot to key archive DB...`);
                        self.levelDbClient.set(levelDBArchiveKey, JSON.stringify(topCommentsObj), (err) => {
                            if (err) {
                                console.error(`Failed to snapshot a key to levelDB archive (${levelDBArchiveKey})`, err);
                                return;
                            }
                            self.saveTstampToIndex(thisRedisObjKey, thisTstamp);
                        });
                    });
                }
            } // end '__keyspace@0__:stats:topComments'

        };

        self.changeEventThrottle = 1000; //ms, maximum for how often this process will run redisKeyspaceSubscriptions actions on any given channel
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
        level(self.levelDbDir, self.leveDbOptions, (err, db) => {
            if (err) {
                console.error(`ERR! Could not connect to "${self.levelDbName}" levelDb. Will not archive any redis key snapshots!`);
                return;
            }
            self.levelDbClient = db;
            self.levelDbClient.set = self.levelDbClient.put; // to make uniform with our redisClient
            if (cback) cback();
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
        // We must also save all archive snapshot tstamps to the ${redisObjectKey}:index:tstamps object which is used later as a record of all snapshot tstamps so they can
        // be easily browsed, or deleted later (if the archive DB gets to big).
        const self = this;
        const tstampIndexKey = `index:snapshotTstamps:${thisArchivedObjKey}`;
        self.levelDbClient.get(tstampIndexKey, (err, archiveIndexJson) => { // archiveIndex is array
            if (err && err.notFound) {
                archiveIndexJson = '[]';
            } else if (err) {
                console.error(`Failed to get ${thisArchiveIndexKey}`, err);
                return;
            }
            const thisArchiveIndex = JSON.parse(archiveIndexJson);
            thisArchiveIndex.push(tstamp);
            // console.log(`${tstampIndexKey.split(':').slice(2).join(':')} has been archived to LevelDb ${thisArchiveIndex.length} times:`, thisArchiveIndex);
            self.levelDbClient.set(tstampIndexKey, JSON.stringify(thisArchiveIndex), (err) => {
                if (err) {
                    console.error(`Failed to set ${levelDBArchiveKey}`);
                } else {
                    if (cback) cback();
                }
            });
        });
    }

    saveObjKeyToIndex(thisArchivedObjKey, cback) {
        // We also save an index of all the redis object keys which are being snapshotted to our levelDB archive. This can be used to browse available snapshots, and look
        // up `index:snapshotTstamps:${thisArchivedObjKey}` arrays.
        const self = this;
        const indexKey = `index:snapshotObjKeys`;
        self.levelDbClient.get(indexKey, (err, snapshotObjKeysJson) => { // snapshotObjKeysJson is array
            if (err && err.notFound) {
                snapshotObjKeysJson = '[]';
            } else if (err) {
                console.error(`Failed to get ${indexKey}`, err);
                return;
            }
            const thisArchiveIndex = JSON.parse(snapshotObjKeysJson);
            if (thisArchiveIndex.indexOf(thisArchivedObjKey) !== -1) {
                if (cback) cback();
                return;
            }
            thisArchiveIndex.push(thisArchivedObjKey);
            console.log(`${thisArchivedObjKey} has been added to LevelDb ${indexKey}. All redis objects being snapshotted:`, thisArchiveIndex);
            self.levelDbClient.set(indexKey, JSON.stringify(thisArchiveIndex), (err) => {
                if (err) {
                    console.error(`Failed to set ${indexKey}`);
                } else {
                    if (cback) cback();
                }
            });
        });
    }

}



const thisArchiveKeysToDisk = new ArchiveKeysToDisk();
export default ArchiveKeysToDisk;
