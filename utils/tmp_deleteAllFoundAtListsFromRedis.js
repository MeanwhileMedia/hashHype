import RedisClient from '../utils/redisClient.js';

// to call from CLI:
// node tmp_deleteAllFoundAtListsFromRedis.js --host_redis_dbs='["short","long"]'

const redisClient = new RedisClient({
    onConnect: () => {
        console.log('Connected to locally hosted redis DBs for deleteFoundAts');
        deleteAllFoundAtKeys();
    }
});

const deleteAllFoundAtKeys = () => {
    redisClient.clients.short.db.keys('*:foundAt', (err, allFoundAtKeys) => {
        console.log(`Deleting ${allFoundAtKeys.length} keys from short DB...`);
        deleteNextBatch(redisClient.clients.short.db, allFoundAtKeys, () => {

            redisClient.clients.long.db.keys('*:foundAt', (err, allFoundAtKeys) => {
                console.log(`Deleting ${allFoundAtKeys.length} keys from long DB...`);
                deleteNextBatch(redisClient.clients.long.db, allFoundAtKeys, () => {
                    console.log('done.');
                });
            })

        });
    });

}

const deleteNextBatch = (dbClient, allFoundAtKeys, cback) => {
    console.log(`${allFoundAtKeys.length} remain...`);
    if (allFoundAtKeys.length === 0) {
        if (cback) cback();
        return;
    }
    dbClient.del(allFoundAtKeys.splice(0, 100), (err, res) => {
        // console.log(`Deleted ${res} keys from short DB.`);
        deleteNextBatch(dbClient, allFoundAtKeys, cback);
    });
}
