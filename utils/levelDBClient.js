import path from 'path';
import yargs from 'yargs';
import level from 'level'; // https://github.com/Level/leveldown#api
import { v4 as uuidv4 } from 'uuid';

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

        self.levelDbDir = path.resolve(process.cwd(), '..', 'hashHypeArchive'); // IMPORTANT - this directory must be above our main hashHype app directory or it will be nuked during our deploy process

        // pubSubUidSubscriptions is used as a temporary record for getViaPubSub requests. The levelDBMaster is instructed to publish the value fetched from levelDB
        // to a unique one-time-use channel that the requesting process is waiting to hear back on.
        self.pubSubUidSubscriptions = {}; // {uid123: {channel: 'uid123', cback: func, key: 'foo:bar:absKey', action: 'getORset'}, etc...}

        // argv.levelDBMaster is passed via a cli arg (see machine config single.config.js) and specifies which process
        // will be the one to open a connection to our levelDB and respond to pubsub requests for a archive values. Only one process can be designated levelDBMaster.
        if (argv.levelDBMaster) {
            self.openLevelDB(() => {
                self.subscribeToRedisPubSubRequests();
                if (opts.onConnect) opts.onConnect();
            });
        } else {
            self.subscribeToRedisPubSubResponses();
            if (opts.onConnect) opts.onConnect();
        }
    }

    openLevelDB(cback) {
        const self = this;
        level(self.levelDbDir, {}, (err, db) => {
            if (err) {
                console.error(`ERR! Could not connect to "${self.levelDbName}" levelDb. Will not archive any redis key snapshots!`);
                return;
            }
            self.openedLevelDB = db;
            if (cback) cback();
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
                console.log(`Another process has requested to get LevelDB key ${message.key}. levelDBMaster will get it and return it as a pubsub message...`);
                self.get(message.key, (dbObj) => {
                    self.redisClient.publish(message.responseChannel, dbObj);
                });
            }
            else if (channel === 'levelDBClient:set') {
                console.log(`Another process has requested to set LevelDB key ${message.key}. levelDBMaster will put the value...`);
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
                console.log(`levelDBMaster has responded to this processes request to get archived data at key ${uniqueChannelSubInfo.key}`);
                uniqueChannelSubInfo.cback(resObj);
            } else if (uniqueChannelSubInfo.action === 'set') {
                console.log(`levelDBMaster has responded to this processes request to set archived data at key ${uniqueChannelSubInfo.key}`);
                uniqueChannelSubInfo.cback(resObj.success);
            }

            // this was a one-and-done subscription. can get rid of it now.
            self.redisClient.unsubscribe(uniqueChannelSubInfo.channel);
            delete self.pubSubUidSubscriptions[channel];
        });
    }

    get(key, cback) {
        const self = this;
        if (!argv.levelDBMaster) {
            self.getViaPubSub(key, cback);
            return;
        }
        self.openedLevelDB.get(key, (err, valJson) => {
            if (err && err.notFound) {
                if (cback) cback(null);
                return
            } else if (err) {
                console.error(`LevelDB error when attempting to get ${thisArchiveIndexKey}`, err);
                if (cback) cback(null);
                return;
            }

            let val;
            try {
                val = JSON.parse(valJson);
            } catch (error) {
                console.warn(`Failed to parse invalid JSON for levelDB key: ${key}`, error);
                if (cback) cback(null);
                return;
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
                console.error(`Failed to set ${levelDBArchiveKey}`);
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

}

export default LevelDBClient;
