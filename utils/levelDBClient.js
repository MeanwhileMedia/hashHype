import path from 'path';
import {exec} from 'child_process';
import {nextTick} from 'process';
import diskUsage from 'diskusage';
import yargs from 'yargs';
import levelup from 'levelup';
import rocksdb from 'rocksdb';
import { v4 as uuidv4 } from 'uuid';
import { mean } from 'mathjs';

const argv = yargs(process.argv.slice(2)).argv;

// This can be used to share a single LevelDB across multiple processes. Since a LevelDB, by nature, can only opened
// by a single process (as a lockfile is placed in the directory), this LevelDBClient works with redis pubsub
// to fetch/send values from our LevelDB archive DB to any other processes that need them.
class LevelDBClient {

    constructor(opts) {
        const self = this;

        if (!opts.redisClient) {
            console.error('Must provide opts.redisClient when creating a new LevelDBClient.');
            return;
        }
        self.redisClient = opts.redisClient;

        self.levelDbDir = path.resolve(process.cwd(), '..', 'hashHype_archive'); // IMPORTANT - this directory must be above our main hashHype app directory or it will be nuked during our deploy process

        // pubSubUidSubscriptions is used as a temporary record for getViaPubSub requests. The levelDBMaster is instructed to publish the value fetched from levelDB
        // to a unique one-time-use channel that the requesting process is waiting to hear back on.
        self.pubSubUidSubscriptions = {}; // {uid123: {channel: 'uid123', cback: func, key: 'foo:bar:absKey', action: 'getORset'}, etc...}

        // The get command will stall our system if we let them stack up indefinitely (on levelDBMaster). We create a get queue and only allow
        // one read command to be executed at a time. When it returns, we move through the queue, calling get in batch if queue has more than one read command waiting.
        self.pendingReadCmd = false;
        self.readQueue = []; // array objects {key: string, cback: func}
        self.readQueueRetryInterval = null;
        self.readQueueRetryIntervalTime = 1000; //ms - how long to wait before re-checking if pendingReadCmd has set to false, and next queue cmd can execute
        self.readQueueMaxExecBatchSize = 100; // the maximum number of keys that will be sent to a single getMany request.

        // This process will also check how much disk this level DB uses in intervals. It will begin deleting the oldest keys once we approach our max disk usage setting.
        self.diskCheckInterval = null;
        self.diskCheckIntervalTime = 60000; // once per minute.
        self.diskCheckMaxDiskUsage = 4; // max GB of disk that this DB uses
        self.diskCheckCorrectionDiskUsage = 3; // target GB of disk that this DB uses AFTER ensureDBDiskUsageIsWithinBounds has looped and deleted

        self.diskCheckCorrectionDeletesArchivedKey = 'stats:topComments'; // when ensureDBDiskUsageIsWithinBounds is loop deleting, this is the key that will have it's oldest snapshots deleted.

        // argv.levelDBMaster is passed via a cli arg (see machine config single.config.js) and specifies which process
        // will be the one to open a connection to our levelDB and respond to pubsub requests for a archive values. Only one process can be designated levelDBMaster.
        if (argv.levelDBMaster) {
            self.openLevelDB((success) => {
                if (!success) {
                    console.error(`ERR! levelDBMaster failed to open LevelDB ${self.levelDbDir}. All archive db logic is blocked!`);
                    return;
                }
                self.subscribeToRedisPubSubRequests();
                self.initDiskCheckInterval();
                if (opts.onConnect) opts.onConnect();
            });
        } else {
            self.subscribeToRedisPubSubResponses();
            if (opts.onConnect) opts.onConnect();
        }
    }

    openLevelDB(cback, retryCount = 0) {
        const self = this;

        const maxRetries = 3;
        const retryWait = 2000;
        const retry = () => {
            if (retryCount < maxRetries) {
                ++retryCount;
                console.warn(`Will retry to open ${self.levelDbDir} levelDb (attempt #${retryCount})...`);
                setTimeout(() => {
                    self.openLevelDB(cback, retryCount);
                }, retryWait);
            } else {
                console.error(`Failed to openLevelDB after ${retryCount} retries. Will not try anymore.`)
                if (cback) cback(false);
            }
        };

        if (self.openedLevelDB) {
            console.warn(`Can't open the levelDB when another client already holds it in ${self.openedLevelDB.status} state...`);
            self.closeLevelDB(() => {
                retry();
            })
            return;
        }

        console.log(`levelDBMaster will now attempt to open levelDB ${self.levelDbDir} ...`);
        self.openedLevelDB = levelup(rocksdb(self.levelDbDir), {
            infoLogLevel: 'info'
        }, (err, db) => {
            if (err) {
                console.error(`ERR! Could not connect to "${self.levelDbDir}" levelDb.`, err);
                retry();
                return;
            }
            console.log(`levelDBMaster has finished opening levelDB ${self.levelDbDir}`);
            if (cback) cback(true);
        });
    }

    closeLevelDB(cback) {
        const self = this;
        if (!self.openedLevelDB || !self.openedLevelDB.close) {
            console.warn(`Can't close a levelDB client because it is not open.`);
            if (cback) cback(false);
            return;
        }
        self.openedLevelDB.close((err) => {
            if (err) {
                console.error(`ERR! Could not close "${self.levelDbName}" levelDb.`);
                if (cback) cback(false);
                return;
            }
            self.openedLevelDB = null;
            if (cback) cback(true);
        });
    }

    subscribeToRedisPubSubRequests() {
        const self = this;
        // This pubsub listening logic is only for the levelDBMaster process. It must listen for requests from other processes that need a value
        // fetched from levelDB. This levelDBMaster process gets the value then emits it through a unique pubsub channel back to the other process.
        self.redisClient.on('message', (channel, messageJson) => {
            if (channel !== 'levelDBClient:get' && channel !== 'levelDBClient:set') return;

            let message;
            try {
                message = JSON.parse(messageJson);
            } catch (error) {
                console.warn(`Failed to parse invalid message JSON for pubsub channel: ${channel}`, error);
                return;
            }

            if (channel === 'levelDBClient:get') {
                // console.log(`Another process has requested to get LevelDB key ${message.key}. levelDBMaster will get it and return it as a pubsub message...`);
                self.get(message.key, (dbObj) => {
                    self.redisClient.publish(message.responseChannel, dbObj);
                }, false); // send false for "parseJson" arg because the data fetched from levelDB is going to be immediately sent through pubsub as JSON. Save CPU.
            }
            else if (channel === 'levelDBClient:set') {
                // console.log(`Another process has requested to set LevelDB key ${message.key}. levelDBMaster will put the value...`);
                self.set(message.key, message.value, (success) => {
                    self.redisClient.publish(message.responseChannel, {success: success});
                });
            }
        });
        self.redisClient.subscribe('levelDBClient:get');
        self.redisClient.subscribe('levelDBClient:set');
    }

    subscribeToRedisPubSubResponses() {
        const self = this;
        // This pubsub listening logic is only for processes which are not the levelDBMaster. They must wait for a response from levelDBMaster
        // after requesting a key be fetched from levelDB.
        self.redisClient.on('message', (channel, messageJson) => {
            const uniqueChannelSubInfo = self.pubSubUidSubscriptions[channel];
            if (!uniqueChannelSubInfo) return;

            let resObj;
            try {
                resObj = JSON.parse(messageJson);
            } catch (error) {
                console.warn(`Failed to parse invalid message JSON for levelDBClient unique channel:`, uniqueChannelSubInfo, error);
                return;
            }

            if (uniqueChannelSubInfo.action === 'get') {
                // console.log(`levelDBMaster has responded to this processes request to get archived data at key ${uniqueChannelSubInfo.key}`);
                uniqueChannelSubInfo.cback(resObj);
            } else if (uniqueChannelSubInfo.action === 'set') {
                // console.log(`levelDBMaster has responded to this processes request to set archived data at key ${uniqueChannelSubInfo.key}`);
                uniqueChannelSubInfo.cback(resObj.success);
            }

            // this was a one-and-done subscription. can get rid of it now.
            self.redisClient.unsubscribe(uniqueChannelSubInfo.channel);
            delete self.pubSubUidSubscriptions[channel];
        });
    }

    get(key, cback, parseJson = true) { // pass parseJson as false and this function will return the JSON string to the cback
        const self = this;
        if (!argv.levelDBMaster) {
            self.getViaPubSub(key, cback);
            return;
        }
        if (self.pendingReadCmd) {
            self.queueReadCmd(key, cback, parseJson);
            return;
        }
        self.pendingReadCmd = true;
        self.openedLevelDB.get(key, (err, valJson) => {
            self.pendingReadCmd = false;
            if (err && err.notFound) {
                if (cback) cback(null);
                return;
            } else if (err) {
                console.error(`LevelDB error when attempting to get ${key}`, err);
                if (cback) cback(null);
                return;
            }
            if (!valJson) { // will be undefined when it isn't found in rocksDB. return null
                if (cback) cback(null);
                return;
            }

            let val;
            if (parseJson) {
                try {
                    val = JSON.parse(valJson);
                } catch (error) {
                    console.warn(`LevelDBClient get failed to parse invalid JSON for levelDB key: ${key}`, error);
                    if (cback) cback(null);
                    return;
                }
            } else {
                val = valJson;
                if (typeof val !== 'string') val = val.toString(); // rocksDB returns Uint8Array buffer. Caller expects JSON string. Convert now.
            }
            if (cback) cback(val);
        });
    }
    getViaPubSub(key, cback) {
        const self = this;
        const thisGetReqUid = uuidv4();
        self.pubSubUidSubscriptions[thisGetReqUid] = {channel: thisGetReqUid, cback: cback, key: key, action: 'get'};
        self.redisClient.subscribe(thisGetReqUid);
        self.redisClient.publish('levelDBClient:get', {key: key, responseChannel: thisGetReqUid});
    }

    queueReadCmd(key, cback, parseJson) {
        const self = this;
        self.readQueue.push({key: key, cback: cback, parseJson: parseJson});
        self.executeReadQueue();
        self.initReadQueueRetryInterval();
    }
    executeReadQueue() {
        const self = this;
        if (self.pendingReadCmd || !self.readQueue.length) return;

        self.pendingReadCmd = true;
        const pendingReadQueue = self.readQueue.splice(0, self.readQueueMaxExecBatchSize);
        console.log(`Will now execute ${pendingReadQueue.length} of ${self.readQueue.length + pendingReadQueue.length} queued levelDb read commands...`);

        const startTime = Date.now();
        const getKeys = pendingReadQueue.map(thisQueued => thisQueued.key);
        self.openedLevelDB.getMany(getKeys, (err, allValsJson) => {
            self.pendingReadCmd = false;
            if (err) {
                console.error(`LevelDB error when attempting to getMany`, err);
                pendingReadQueue.forEach((thisQueued) => {
                    if (thisQueued.cback) thisQueued.cback(null);
                });
                return;
            }

            const endTime = Date.now();
            console.log(`Successfully ran levelDb getMany command for ${pendingReadQueue.length} keys. ${self.readQueue.length} queued commands remain...`);
            // const readSpeed = Math.ceil(pendingReadQueue.length / ((endTime-startTime)/1000));
            // self.readSpeedHistory = self.readSpeedHistory || [];
            // self.readSpeedHistory.splice(500);
            // self.readSpeedHistory.push(readSpeed);
            // console.warn(`LevelDBClient just ran ${readSpeed} read commands per second (rps). The average is ${Math.ceil(mean(self.readSpeedHistory))}rps.`);

            allValsJson.forEach((thisValJson, thisValIndex) => {
                if (!thisValJson) { // will be undefined when it isn't found in rocksDB. return null
                    if (pendingReadQueue[thisValIndex].cback) pendingReadQueue[thisValIndex].cback(null);
                    return;
                }

                let val;
                if (pendingReadQueue[thisValIndex].parseJson) {
                    try {
                        val = JSON.parse(thisValJson);
                    } catch (error) {
                        console.warn(`LevelDBClient getMany failed to parse invalid JSON for levelDB key: ${pendingReadQueue[thisValIndex].key}`, error);
                        if (pendingReadQueue[thisValIndex].cback) pendingReadQueue[thisValIndex].cback(null);
                        return;
                    }
                } else {
                    val = thisValJson;
                    if (typeof val !== 'string') val = val.toString(); // rocksDB returns Uint8Array buffer. Caller expects JSON string. Convert now.
                }
                if (pendingReadQueue[thisValIndex].cback) pendingReadQueue[thisValIndex].cback(val);
            });
        });
    } // end executeReadQueue
    initReadQueueRetryInterval() {
        const self = this;
        if (!self.readQueueRetryInterval) {
            self.readQueueRetryInterval = setInterval(() => {
                self.executeReadQueue();
            }, self.readQueueRetryIntervalTime);
        }
    }

    set(key, valObj, cback) { // levelDB only uses objects (json). valObj must be an array/object
        const self = this;
        if (typeof valObj !== 'object') {
            console.error(`Can't set value to LevelDB key ${key}. Provided value must be of type object.`);
            if (cback) cback(false);
        }
        if (!argv.levelDBMaster) {
            self.setViaPubSub(key, valObj, cback);
            return;
        }
        self.openedLevelDB.put(key, JSON.stringify(valObj), (err) => {
            if (err) {
                console.error(`Failed to set ${key}`);
                if (cback) cback(false);
            } else {
                if (cback) cback(true);
            }
        });
    }
    setViaPubSub(key, valObj, cback) {
        const self = this;
        const thisGetReqUid = uuidv4();
        self.pubSubUidSubscriptions[thisGetReqUid] = {channel: thisGetReqUid, cback: cback, key: key, action: 'set'};
        self.redisClient.subscribe(thisGetReqUid);
        self.redisClient.publish('levelDBClient:set', {key: key, value: valObj, responseChannel: thisGetReqUid});
    }

    delete(key, cback) {
        // JWW todo - support deletes from non master processes?
        const self = this;
        self.openedLevelDB.del(key, (err) => {
            if (err) {
                console.error('LevelDB delete error:', err);
                if (cback) cback(false, curKeyIndex);
            } else {
                if (cback) cback(true, curKeyIndex);
            }
        });
    }

    batch(batchCmds, cback) {
        const self = this;
        self.openedLevelDB.batch(batchCmds, (err) => {
            if (err) {
                console.error('LevelDB batch error:', err);
                if (cback) cback(false);
            } else {
                if (cback) cback(true);
            }
        });
    }

    compactRange(start, end, cback) {
        const self = this;
        console.warn(`Will now compact range of keys: ${start} -> ${end}`);
        self.openedLevelDB.compactRange(start, end, (err) => {
            if (err) {
                console.error('LevelDB compactRange error:', err);
                if (cback) cback(false);
            } else {
                console.warn('Completed LevelDB compactRange garbage collection.')
                if (cback) cback(true);
            }
        });
    }

    initDiskCheckInterval() {
        const self = this;
        if (self.isCheckingDisk) {
            console.warn(`Detected overlapping calls to initDiskCheckInterval...`);
            return;
        }
        self.isCheckingDisk = true;

        self.ensureDBDiskUsageIsWithinBounds(() => {
            self.isCheckingDisk = false;
        });

        if (self.diskCheckInterval) return;
        self.diskCheckInterval = setInterval(() => {
            self.initDiskCheckInterval();
        }, self.diskCheckIntervalTime);
    }

    ensureDBDiskUsageIsWithinBounds(cback, evictingKey, snapshotTstampIndex, deleteBatchSize, deletedKeys = []) {
        const self = this;
        evictingKey = evictingKey || self.diskCheckCorrectionDeletesArchivedKey;
        const minDeleteBatchSize = 10;
        const maxDeleteBatchSize = 1000;

        if (!snapshotTstampIndex) {
            // this must be the first iteration an we have not yet established an array of snapshot keys to be deleted in loop. Do now.
            self.get(`index:snapshotTstamps:${evictingKey}`, (gotSnapshotTstampIndex) => {
                if (!gotSnapshotTstampIndex) {
                    console.warn(`Could not find index:snapshotTstamps:${evictingKey} in redis. There may not yet be any snapshots saved for this key yet.`);
                    if (cback) cback();
                    return;
                }

                self.ensureDBDiskUsageIsWithinBounds(cback, evictingKey, gotSnapshotTstampIndex, minDeleteBatchSize, deletedKeys);
            });
            return;
        }

        self.getDbDiskUsage(`${evictingKey}:${snapshotTstampIndex[0]}`, `${evictingKey}:${snapshotTstampIndex[snapshotTstampIndex.length-1]}`, (startingDiskUsageBytes) => {
            if (startingDiskUsageBytes < self.gbToBytes(self.diskCheckMaxDiskUsage) && !deletedKeys.length) { // if deletedKeys has length, then we are in-flight DB deletions to meet self.diskCheckCorrectionDiskUsage
                console.log(`LevelDB ${self.levelDbDir} is within acceptable disk usage: ${Math.round(self.bytesToGb(startingDiskUsageBytes)*1000)/1000}GB used of ${self.diskCheckMaxDiskUsage}GB available`);
                if (cback) cback(); // disk usage is OK
                return;
            }
            console.warn(`LevelDB ${self.levelDbDir} is too large. Disk usage: ${Math.round(self.bytesToGb(startingDiskUsageBytes)*1000)/1000}GB used of ${self.diskCheckMaxDiskUsage}GB available`);

            console.warn(`At start of ensureDBDiskUsageIsWithinBounds, there were ${snapshotTstampIndex.length} snapshots of ${evictingKey}`);
            if (snapshotTstampIndex.length < deleteBatchSize) {
                console.warn(`Cannot attempt to delete a batch of ${deleteBatchSize} snapshots when index:snapshotTstamps:${evictingKey} only points to ${snapshotTstampIndex.length} keys. Possible index corruption. Please inspect...`);
                return;
            }

            const batchCmds = [];
            for (let batchCmdCount = 0; batchCmdCount < deleteBatchSize; batchCmdCount++) {
                const thisKey = `${evictingKey}:${snapshotTstampIndex.shift()}`;
                batchCmds.push({type: 'del', key: thisKey});
                deletedKeys.push(thisKey);
            }

            // First re-save the index:snapshotTstamps array to levelDB (with the about-to-be-deleted tstamps removed)
            self.set(`index:snapshotTstamps:${evictingKey}`, snapshotTstampIndex, () => {
                self.batch(batchCmds, (success) => {
                    if (!success) {
                        console.warn(`ensureDBDiskUsageIsWithinBounds failed to delete a batch of ${batchCmds.length} snapshot keys.`);
                        if (cback) cback();
                        return;
                    }
                    console.warn(`ensureDBDiskUsageIsWithinBounds deleted ${batchCmds.length} keys.`);

                    self.getDbDiskUsage(`${evictingKey}:${snapshotTstampIndex[0]}`, `${evictingKey}:${snapshotTstampIndex[snapshotTstampIndex.length-1]}`, (endingDiskUsageBytes) => {
                        const dbCorrectionDiskUsageBytes = self.gbToBytes(self.diskCheckCorrectionDiskUsage);
                        const endingDBDiskUsageGb = Math.round(self.bytesToGb(endingDiskUsageBytes)*1000)/1000; // just for logging
                        if (endingDiskUsageBytes < dbCorrectionDiskUsageBytes) {
                            console.warn(`SUCCESS! LevelDB ${self.levelDbDir} has been corrected to acceptable disk usage: ${endingDBDiskUsageGb}GB`);
                            self.compactRange(deletedKeys[0], deletedKeys[deletedKeys.length-1], () => {
                                if (cback) cback();
                            });
                            return;
                        }

                        const bytesDifference = startingDiskUsageBytes - endingDiskUsageBytes;
                        const estBytesPerKey = bytesDifference / deleteBatchSize;
                        const bytesStillNeedToBeDeleted = endingDiskUsageBytes - dbCorrectionDiskUsageBytes;
                        console.warn(`ensureDBDiskUsageIsWithinBounds estimates that the previous delete batch (${batchCmds.length}) freed ${bytesDifference}bytes. Each ${evictingKey} snapshot is approximately ${estBytesPerKey}bytes.`)

                        if (bytesDifference <= 0) {
                            console.warn(`Detected that a levelDB delete command did not result in any freed bytes. There may be an error in our disk space measurement, or other unknown issue. Will stop the ensureDBDiskUsageIsWithinBounds loop at risk of deleting all keys.`);
                            if (cback) cback();
                            return;
                        }

                        let estNextDeleteBatchSize = (bytesStillNeedToBeDeleted / estBytesPerKey) / 2; // we cut this estimated number in half because better to loop more times than accidentally delete too much data in a single loop.
                        estNextDeleteBatchSize = Math.floor(Math.max(estNextDeleteBatchSize, minDeleteBatchSize));
                        estNextDeleteBatchSize = Math.min(estNextDeleteBatchSize, maxDeleteBatchSize);

                        // Loop this function again to check diskUsage readings and continue deletions if necc.
                        console.warn(`LevelDB ${self.levelDbDir} is still too large (${endingDBDiskUsageGb}GB). Need to free ${Math.round(self.bytesToGb(bytesStillNeedToBeDeleted)*1000)/1000}GB. Will delete ${estNextDeleteBatchSize} ${evictingKey} snapshot keys...`);
                        self.ensureDBDiskUsageIsWithinBounds(cback, evictingKey, snapshotTstampIndex, estNextDeleteBatchSize, deletedKeys);
                    });

                }); // end self.batch(
            }); // end self.set(`index:snapshotTstamps

        }); // end self.getDbDiskUsage
    } // end ensureDBDiskUsageIsWithinBounds

    getDbDiskUsage(startKey, endKey, cback) {
        const self = this;
        console.log(`Will now get approximate size on disk of all keys from ${startKey} -> ${endKey}`);
        self.openedLevelDB.approximateSize(startKey, endKey, (err, size) => {
            if (err) {
                console.warn(`getDbDiskUsage approximateSize returned error:`, err);
                if (cback) cback(null);
                return null;
            }
            if (cback) cback(size);
        })
    }

    gbToBytes(gb) {
        return gb * 1073741824; // using binary conversion
    }
    bytesToGb(bytes) {
        return bytes / 1073741824; // using binary conversion
    }

}

export default LevelDBClient;
