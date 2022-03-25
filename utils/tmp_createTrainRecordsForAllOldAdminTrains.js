import RedisClient from '../utils/redisClient.js';
import symbolModel from '../utils/objectModels/symbol.js';

const redisClient = new RedisClient({
    onConnect: () => {
        console.log('Connected to locally hosted redis DBs for getAllChangedSymbolsAndSaveHistoryRecord');
        getAllChangedSymbolsAndSaveHistoryRecord('stock', (allStockKeys) => {
            getAllChangedSymbolsAndSaveHistoryRecord('coin', (allCoinKeys) => {

                createHistoryRecords(allStockKeys.concat(allCoinKeys));

            });
        });

    }
});

const getAllChangedSymbolsAndSaveHistoryRecord = (symbolType, cback) => {
    redisClient.clients.long.db.keys(`symbol:${symbolType}*`, (err, allFoundSymbols) => {
        console.log(`Found ${allFoundSymbols.length} ${symbolType} symbols...`);
        if (cback) cback(allFoundSymbols)
    });

}

const defaultSymbolObj = symbolModel.createSymbolObject({symbol: 'default', name: 'default'})
let foundChangedSymbolCount = 0;
let foundSymbolAliasCount = 0;
const historyObjects = [];
const trainingNotRelevantHistoryKey = 'training:notRelevant:history';

const createHistoryRecords = (allSymbolKeys, curKeyIndex = 0) => {
    if (!allSymbolKeys[curKeyIndex]) {
        console.log(`Finished looping ${curKeyIndex}/${allSymbolKeys.length} symbols!`);
        console.log(`Found ${foundChangedSymbolCount} changed symbols and created train histories.`);
        console.log(`Found ${foundSymbolAliasCount} symbol aliases and created train histories.`);
        // console.log(historyObjects);
        saveAllHistoryObjects();
        return;
    }
    redisClient.clients.long.db.get(allSymbolKeys[curKeyIndex], (err, thisSymbolObjJson) => {
        if (err) {
            console.warn(err)
            return;
        }
        const thisSymbolObj = JSON.parse(thisSymbolObjJson);


        if (thisSymbolObj.class === 'keyAlias') {
            ++foundSymbolAliasCount;
            //console.log('Found key alias symbol:', thisSymbolObj);
            historyObjects.push(newTrainingHistoryObj({
                actionName: 'editSymbolFunction',
                objectChanged: thisSymbolObj.parentKey,
                actions: [['redis_set', allSymbolKeys[curKeyIndex], JSON.stringify(thisSymbolObj)]],
                tstamp: Date.now(),
                adminName: 'Joe Webb'
            }));

            createHistoryRecords(allSymbolKeys, ++curKeyIndex);
            return;
        }

        if (thisSymbolObj.match !== defaultSymbolObj.match || thisSymbolObj.get !== defaultSymbolObj.get) {
            ++foundChangedSymbolCount;
            //console.log('Found changed symbol:', thisSymbolObj);
        }

        if (thisSymbolObj.match !== defaultSymbolObj.match) {
            historyObjects.push(newTrainingHistoryObj({
                actionName: 'editSymbolFunction',
                objectChanged: allSymbolKeys[curKeyIndex],
                keysChanged: ['match'],
                actions: [['set', thisSymbolObj.match]],
                tstamp: Date.now(),
                adminName: 'Joe Webb',
            }));

        }

        if (thisSymbolObj.get !== defaultSymbolObj.get) {
            historyObjects.push(newTrainingHistoryObj({
                actionName: 'editSymbolFunction',
                objectChanged: allSymbolKeys[curKeyIndex],
                keysChanged: ['get'],
                actions: [['set', thisSymbolObj.get]],
                tstamp: Date.now(),
                adminName: 'Joe Webb',
            }));
        }

        createHistoryRecords(allSymbolKeys, ++curKeyIndex);
    });
}

const saveAllHistoryObjects = () => {
    console.log(`A total of ${historyObjects.length} train history objects will be zadd to ${trainingNotRelevantHistoryKey}`);
    const zaddVals = [];
    historyObjects.forEach((thisHistObj) => {
        zaddVals.push(thisHistObj.tstamp, JSON.stringify(thisHistObj));
    });
    redisClient.clients.long.db.zadd(trainingNotRelevantHistoryKey, zaddVals, (err, itemsAddedCount) => {
        if (err) {
            console.warn(err)
            return;
        }
        if (itemsAddedCount !== historyObjects.length) console.warn(`Expected ${historyObjects.length} training history objects to be added to set ${trainingNotRelevantHistoryKey}. Only ${itemsAddedCount} were added.`);
        console.log('Complete!');
    });
}

const newTrainingHistoryObj = (initial) => {
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
