import RedisClient from '../utils/redisClient.js';

// to call from CLI:
// node tmp_deleteAllCommentsFromRedis.js --host_redis_dbs='["short","long"]'

const redisClient = new RedisClient({
    onConnect: () => {
        console.log('Connected to locally hosted redis DBs for deleteAllCommentsFromRedis');
        deleteAllComments();
    }
});

const deleteAllComments = () => {
    redisClient.clients.short.db.keys('comment:*', (err, allCommentKeys) => {
        console.log(`Deleting ${allCommentKeys.length} keys from short DB...`);
        deleteNextBatch(redisClient.clients.short.db, allCommentKeys, () => {

            redisClient.clients.long.db.keys('comment:*', (err, allCommentKeys) => {
                console.log(`Deleting ${allCommentKeys.length} keys from long DB...`);
                deleteNextBatch(redisClient.clients.long.db, allCommentKeys, () => {
                    console.log('done.');
                });
            })

        });
    });

}

const deleteNextBatch = (dbClient, allCommentKeys, cback) => {
    console.log(`${allCommentKeys.length} remain...`);
    if (allCommentKeys.length === 0) {
        if (cback) cback();
        return;
    }
    dbClient.del(allCommentKeys.splice(0, 100), (err, res) => {
        // console.log(`Deleted ${res} keys from short DB.`);
        deleteNextBatch(dbClient, allCommentKeys, cback);
    });
}
