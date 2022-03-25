import trainingModels from '../utils/objectModels/training.js';
import symbolModel from '../utils/objectModels/symbol.js';
import keyAliasModel from '../utils/objectModels/keyAlias.js';

// This file includes all the socket requests to set/alter redis data based on the trend training UI
class HbClientSocketDbResponses_admin {
    constructor(opts) {
        this.redisClient = opts.redisClient;
        this.trainingNotRelevantKey = 'training:notRelevant';
        this.trainingNotRelevantHistoryKey = 'training:notRelevant:history'; // a sorted set holding the history of all changes made to the 'training:notRelevant' object (sorted by tstamp of when training edit was made)
        this.trainingNotRelevant = null;
        this.syncTrainingNotRelevant(); // sets to this.trainingNotRelevant (from db, or as newly empty if not found in db)
    }

    markUserNotRelevant(message, socket, adminCodeStatus) {
        const self = this;

        // Respond to client right away. Not going to wait.
        socket.send({
            channel: `status:clientResponse`, // this is just a generic response message that doesn't have any followup logic. Client just logs to console.
            data: `markUserNotRelevant (${message.data.username}) request received.`,
        });

        const username = message.data.username;
        const commentId = message.data.commentId; // optional (so the comment which caused this user to become not relevant will be deleted)
        if (!username) return;

        const now = Date.now();
        const exists = self.trainingNotRelevant.users.find(thisUser => thisUser.username === username);
        if (!exists) {
            self.trainingNotRelevant.users.push({
                username: username,
                tstamp: now
            });
        }

        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: `user:${username}`,
            tstamp: now
        });

        const editHistoryObject = self.newTrainingHistoryObj({
            actionName: 'markUserNotRelevant',
            objectChanged: self.trainingNotRelevantKey,
            keysChanged: ['users'],
            actions: [['push', username]],
            tstamp: now,
            adminName: adminCodeStatus.adminInfo.name,
            adminIp: adminCodeStatus.matchedIp
        });
        self.saveTrainingNotRelevant([editHistoryObject]);
    }

    markWordNotRelevant(message, socket, adminCodeStatus) {
        const self = this;

        // Respond to client right away. Not going to wait.
        socket.send({
            channel: `status:clientResponse`, // this is just a generic response message that doesn't have any followup logic. Client just logs to console.
            data: `markWordNotRelevant (${message.data.word}) request received.`,
        });

        const removeWord = message.data.word;
        const commentId = message.data.commentId; // optional (so the comment which caused this word to become not relevant will have this word deducted from it)
        if (!removeWord) return;

        const now = Date.now();
        const historyObjects = [];

        // add this new entry to our global traingin:notRelevant object
        const exists = self.trainingNotRelevant.words.find(thisWord => thisWord.word === removeWord);
        if (!exists) {
            self.trainingNotRelevant.words.push({
                word: removeWord,
                tstamp: now
            });
        }
        historyObjects.push(self.newTrainingHistoryObj({
            actionName: 'markWordNotRelevant',
            objectChanged: self.trainingNotRelevantKey,
            keysChanged: ['words'],
            actions: [['push', removeWord]],
            tstamp: now,
            adminName: adminCodeStatus.adminInfo.name,
            adminIp: adminCodeStatus.matchedIp
        }));


        // get the wordToCommentsIndex and remove any points earned for this word from all host comments
        const commentIndexKey = `index:wordToComments:${removeWord}`;
        self.redisClient.zrange(commentIndexKey, 0, Infinity, (wordToCommentsIndex) => {
            if (!wordToCommentsIndex) return;
            // This is the last time we will use this wordToComments index since the word is being deleted. Delete index too.
            self.redisClient.del(commentIndexKey);
            historyObjects.push(self.newTrainingHistoryObj({
                actionName: 'markWordNotRelevant',
                objectChanged: commentIndexKey,
                actions: [['redis_del', commentIndexKey]],
                tstamp: now,
                adminName: adminCodeStatus.adminInfo.name,
                adminIp: adminCodeStatus.matchedIp
            }));

            // Now loop through the comment index and update all comments
            let commentsUpdated = 0;
            wordToCommentsIndex.forEach((commentId) => {
                self.deleteWordFromCommentAndSave(removeWord, commentId, (commentRedisKey) => {
                    commentsUpdated++;
                    // Add this key to our training change record so other processes can respond too
                    self.trainingNotRelevant.lastAffected.push({
                        key: commentRedisKey,
                        tstamp: now
                    });
                    historyObjects.push(self.newTrainingHistoryObj({
                        actionName: 'markWordNotRelevant',
                        objectChanged: `comment:${commentId}`,
                        keysChanged: ['words', 'points'],
                        actions: [['delete', removeWord]],
                        tstamp: now,
                        adminName: adminCodeStatus.adminInfo.name,
                        adminIp: adminCodeStatus.matchedIp
                    }));

                    if (commentsUpdated >= wordToCommentsIndex.length) {
                        // Last, save our new training data to redis
                        self.saveTrainingNotRelevant(historyObjects);
                    }
                })
            });
        });
    }

    deleteWordFromComment(message, socket, adminCodeStatus) {
        const self = this;

        // Respond to client right away. Not going to wait.
        socket.send({
            channel: `status:clientResponse`, // this is just a generic response message that doesn't have any followup logic. Client just logs to console.
            data: `deleteWordFromComment (${message.data.word}) request received.`,
        });

        const now = Date.now();
        const word = message.data.word;
        const commentId = message.data.commentId;
        const commentKey = `comment:${commentId}`;
        if (!word || !commentId) return;
        self.deleteWordFromCommentAndSave(word, commentId, (commentRedisKey) => {
            self.trainingNotRelevant.lastAffected = [];
            self.trainingNotRelevant.lastAffected.push({
                key: commentKey,
                tstamp: now
            });
            const historyObj = self.newTrainingHistoryObj({
                actionName: 'deleteWordFromComment',
                objectChanged: commentKey,
                keysChanged: ['words', 'points'],
                actions: [['delete', word]],
                tstamp: now,
                adminName: adminCodeStatus.adminInfo.name,
                adminIp: adminCodeStatus.matchedIp
            });
            self.saveTrainingNotRelevant([historyObj]);
        });
    }

    deleteComment(message, socket, adminCodeStatus) {
        const self = this;

        // Respond to client right away. Not going to wait.
        socket.send({
            channel: `status:clientResponse`, // this is just a generic response message that doesn't have any followup logic. Client just logs to console.
            data: `deleteComment (${message.data.commentId}) request received.`,
        });

        const now = Date.now();
        const historyObjects = [];

        const commentId = message.data.commentId;
        const commentKey = `comment:${commentId}`;
        if (!commentId) return;

        console.log(`deleteComment: ${commentId}`);
        this.redisClient.del(commentKey);
        historyObjects.push(self.newTrainingHistoryObj({
            actionName: 'deleteComment',
            objectChanged: commentKey,
            actions: [['redis_del', commentKey]],
            tstamp: now,
            adminName: adminCodeStatus.adminInfo.name,
            adminIp: adminCodeStatus.matchedIp
        }));

        // add this new comment to our global traingin:notRelevant object
        const exists = self.trainingNotRelevant.comments.find(thisComment => thisComment.id === commentId);
        if (!exists) {
            self.trainingNotRelevant.comments.push({
                id: commentId,
                tstamp: now
            });
        }

        self.trainingNotRelevant.lastAffected = [];
        self.trainingNotRelevant.lastAffected.push({
            key: commentKey,
            tstamp: now
        });

        historyObjects.push(self.newTrainingHistoryObj({
            actionName: 'deleteComment',
            objectChanged: self.trainingNotRelevantKey,
            keysChanged: ['comments'],
            actions: [['push', commentId]],
            tstamp: now,
            adminName: adminCodeStatus.adminInfo.name,
            adminIp: adminCodeStatus.matchedIp
        }));
        self.saveTrainingNotRelevant(historyObjects);
    }

    editSymbolFunction(message, socket, adminCodeStatus) {
        const self = this;

        // Respond to client right away. Not going to wait.
        socket.send({
            channel: `status:clientResponse`, // this is just a generic response message that doesn't have any followup logic. Client just logs to console.
            data: `editSymbolFunction (${message.data.symbol.symbol} ${message.data.functionName}) request received.`,
        });

        const now = Date.now();
        const historyObjects = [];

        const opts = message.data;
        if (!opts || !opts.symbol || !opts.functionName || !opts.functionString) return;
        if (opts.functionName !== 'get' && opts.functionName !== 'match') return;
        const symbolRedisKey = `symbol:${opts.symbol.type}:${opts.symbol.symbol}`
        this.redisClient.get(symbolRedisKey, (symbolRedisData) => {
            if (!symbolRedisData) {
                console.log(`Could not get ${symbolRedisKey}`);
                return;
            }
            // First run it in a try/catch before saving to redis - in case the edited function contains an error.
            let funcdSymbolData = null;
            try {
                let testFunc;
                if (opts.functionName === 'get') {
                    symbolRedisData.get = opts.functionString
                    funcdSymbolData = symbolModel.execGet(symbolRedisData);
                    if (typeof funcdSymbolData !== 'object') throw 'Symbol get function must return an object.'
                }
                if (opts.functionName === 'match') {
                    symbolRedisData.match = opts.functionString
                    const matchOutcome = symbolModel.execMatch(symbolRedisData, 'bui_gme');
                    if (typeof matchOutcome !== 'boolean') throw 'Symbol match function must return a boolean.'
                }
            } catch (error) {
                console.warn(`Edited symbol (${symbolRedisData.symbol}) function ${opts.functionName}() ran with error. Won't save.`, error);
                return;
            }
            historyObjects.push(self.newTrainingHistoryObj({
                actionName: 'editSymbolFunction',
                objectChanged: symbolRedisKey,
                keysChanged: [opts.functionName],
                actions: [['set', opts.functionString]],
                tstamp: now,
                adminName: adminCodeStatus.adminInfo.name,
                adminIp: adminCodeStatus.matchedIp
            }));

            // Now check if this admin edit resulted in any new symbolAliases
            if (funcdSymbolData && funcdSymbolData.symbolAlias && funcdSymbolData.symbolAlias.length) { // this symbol has the symbolAlias prop defined (array). These aliases may or may not have been just newly defined in this admin edit. Either way, we will save them (again) now.
                symbolRedisData.symbolAlias = funcdSymbolData.symbolAlias; // so it saves as a top level prop on the symbol object too
                funcdSymbolData.symbolAlias.forEach((thisAliasStr) => {
                    const aliasRedditKey = `symbol:${symbolRedisData.type}:${thisAliasStr}`
                    const newAliasObject = keyAliasModel.createKeyAliasObject({parentKey: symbolRedisKey});
                    self.redisClient.get(aliasRedditKey, (existingObjAtKey) => {
                        if (existingObjAtKey) {
                            console.warn(`WARN! Will now save a keyAlias object at key ${aliasRedditKey}. This will overwrite an existing object:`, existingObjAtKey);
                        }
                        console.warn(`Now saving new symbol alias: ${aliasRedditKey} -> ${symbolRedisKey}`);
                        self.redisClient.set(aliasRedditKey, newAliasObject);
                    });
                    historyObjects.push(self.newTrainingHistoryObj({
                        actionName: 'editSymbolFunction',
                        objectChanged: symbolRedisKey,
                        actions: [['redis_set', aliasRedditKey, JSON.stringify(newAliasObject)]],
                        tstamp: now,
                        adminName: adminCodeStatus.adminInfo.name,
                        adminIp: adminCodeStatus.matchedIp
                    }));
                });
            }

            // Now check if this admin edit resulted in a new symbol.prettyName
            if (funcdSymbolData && funcdSymbolData.prettyName) {
                console.warn(`A prettyName was defined for ${symbolRedisKey} (${funcdSymbolData.prettyName}).`)
                symbolRedisData.prettyName = funcdSymbolData.prettyName; // so it saves as a top level prop on the symbol object too
                historyObjects.push(self.newTrainingHistoryObj({
                    actionName: 'editSymbolFunction',
                    objectChanged: symbolRedisKey,
                    keysChanged: ['prettyName'],
                    actions: [['set', funcdSymbolData.prettyName]],
                    tstamp: now,
                    adminName: adminCodeStatus.adminInfo.name,
                    adminIp: adminCodeStatus.matchedIp
                }));
            }

            // Looks legit, save now.
            console.log(`Saving ${opts.functionName}() function edit on symbol ${opts.symbol.symbol}:`, opts.functionString);
            self.redisClient.set(symbolRedisKey, symbolModel.minimizeForDb(symbolRedisData));

            self.saveTrainingNotRelevant(historyObjects); // even though this action didn't directly edit training:notRelevant, we still need to save the history objects to training:notRelevant:history

        }); // end this.redisClient.get(symbolRedisKey
    }

    deleteWordFromCommentAndSave(removeWord, commentId, cback) { // send commentRedisKey to cback
        const self = this;
        // This is not a socket message based function. It's a helper for our other socket methods in this class.
        const commentRedisKey = `comment:${commentId}`;
        self.redisClient.get(commentRedisKey, (comment) => {
            if (!comment) {
                console.log(`Could not get ${commentRedisKey}`);
                return;
            }
            // First remove points
            for (const [pointsTimeBucketKey, pointsTimeBucket] of Object.entries(comment.points)) {
                delete pointsTimeBucket[removeWord];
            }

            // then, remove it from the comment's words array);
            delete comment.words[removeWord];

            // save back to redis
            self.redisClient.set(commentRedisKey, comment);
            // all done
            if (cback) cback(commentRedisKey);
        });
    }

    syncTrainingNotRelevant() {
        // This function gets training:notRelevant from redis (used in discarding comments from flagged users), and adds
        // a keyspace listener so local data is always synced with redis.
        const self = this;
        this.redisClient.get(self.trainingNotRelevantKey, (trainingNotRelevant) => {
            if (!trainingNotRelevant) {
                // Since this topCommentStats process writes to the redis 'training:notRelevant' object,
                // it should always be locally defined. Instantiate a blank object now.
                self.trainingNotRelevant = trainingModels.createTrainingNotRelevantObject();
                console.log(`${self.trainingNotRelevantKey} was not yet saved to redis.`);
                return;
            }
            self.trainingNotRelevant = trainingNotRelevant;
        });
        if (self.trainingNotRelevantIsSynced) return;
        self.trainingNotRelevantIsSynced = true;
        self.redisClient.on('message', (channel, message) => {
            if (channel === `__keyspace@0__:${self.trainingNotRelevantKey}`) self.syncTrainingNotRelevant();
        });
        self.redisClient.subscribe(`__keyspace@0__:${self.trainingNotRelevantKey}`);
    }

    saveTrainingNotRelevant(historyObjects = []) {
        const self = this;
        // Save our training:notRelevant object
        self.redisClient.set(self.trainingNotRelevantKey, self.trainingNotRelevant);
        // AND add a history record of this edit
        if (historyObjects.length) {
            const zaddVals = [];
            historyObjects.forEach((thisHistObj) => {
                zaddVals.push(thisHistObj.tstamp, JSON.stringify(thisHistObj));
            });
            self.redisClient.zadd(self.trainingNotRelevantHistoryKey, zaddVals, (itemsAddedCount) => {
                if (itemsAddedCount !== historyObjects.length) console.warn(`Expected ${historyObjects.length} training history objects to be added to set ${self.trainingNotRelevantHistoryKey}. Only ${itemsAddedCount} were added.`);
            });
        }

        // We automatically clear the lastAffected array on self.trainingNotRelevant after a timeout
        // (or else the last affected keys will persist upon process restarts, and they will attempt to respond again)
        if (self.lastAffectedTimeout) clearTimeout(self.lastAffectedTimeout);
        self.lastAffectedTimeout = setTimeout(() => {
            console.log('Automatically clearing trainingNotRelevant.lastAffected after timeout.');
            self.trainingNotRelevant.lastAffected = [];
            self.redisClient.set(self.trainingNotRelevantKey, self.trainingNotRelevant);
            self.lastAffectedTimeout = null;
        }, 60000*10); // We assume 10 minutes will be enough for all processes to finish responding
    }

    newTrainingHistoryObj(initial) {
        return {
            actionName: initial.actionName, // 'markWordNotRelevant' etc..
            objectChanged: initial.objectChanged, // 'training:notRelevat', 'symbol:stock:GME', etc - The redis key to the object which changed as a result of this admin train action
            keysChanged: initial.keysChanged || [], // ['words'] etc.. // The key on objectChanged which was changed as a result of this train action
            actions: initial.actions || [], // an array of arrays describing the change. I.e: [['push', 'agentOOjoe'], ['zadd', score, value], etc..] - follows format command,arg1,arg2,etc
            tstamp: initial.tstamp || Date.now(), // the moment in time that this edit was made
            adminName: initial.adminName || null,
            adminIp: initial.adminIp || null
        }
    }

}; // end HbClientSocketDbResponses_admin

export default HbClientSocketDbResponses_admin;
