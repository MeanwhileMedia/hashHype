import natural from 'natural';
import urlRegex from 'url-regex';
import urlNormalize from 'normalize-url';
import RedisClient from '../utils/redisClient.js';
import symbolModel from '../utils/objectModels/symbol.js';

import events from 'events';
events.EventEmitter.defaultMaxListeners = Infinity;

const naturalTokenizer = new natural.WordPunctTokenizer();
const naturalNGrams = natural.NGrams;

class ExtractWordsFromComments {

    // Step 1: strip out insignificant words like "it", "the" (built into PorterStemmer.tokenizeAndStem)
    // Step 2: tokenize and stem every remaining word (built into PorterStemmer.tokenizeAndStem)
    // Step 3: Store word object for every single word that is ALSO a symbol
    // Step 4: Store every bigram to redis as a word object
    // Step 5: Store every trigram to redis as a word object
    // Step 6: As topWordStats continues to produce occurance counts - comments which contain topWords will be pointed accordingly, and maybe trend.

    constructor() {
        const self = this;
        this.redisClient = null;
        this.trackWordsFor = 86400000; // ms (24hrs) How long should we keep tstamps stored to word:foo_bar:foundAt lists
        this.initRedisClient(() => {
            self.syncTrainingNotRelevant();
            self.initKeyspaceSubscriptions();
        });
    }

    initRedisClient(cback) {
        const self = this;
        self.redisClient = new RedisClient({
            onConnect: () => {
                console.log('Connected new redis sub client for word extractor class.');
                if(cback) cback();
            }
        });
    }

    initKeyspaceSubscriptions() {
        const self = this;
        this.redisClient.on('pmessage', function (matchedPattern, patternWithKey, action){
            if (action !== 'set') return;
            // If this event was sent as part of the set pattern subcribed keyspace event, then it's "patternWithKey" will be: __keyspace@0__:comment:0b90a45d-283b-4716-aa14-ac9f99ac54b1
            let rawCommentKey = patternWithKey;
            rawCommentKey = rawCommentKey.replace('__keyspace@0__:', '');
            self.redisClient.get(rawCommentKey, (comment) => {
                self.redisClient.del(rawCommentKey); // We are going to reform the rawComment: into a comment:. Delete rawComment from redis.
                if (!comment || !comment.body) return;
                comment.pendingSymbols = {};
                self.preserveSymbolsInCommentBody(comment, () => {
                    self.extractWordSequences(comment, () => {
                        delete comment.pendingSymbols; // was just a temporary prop for preserveSymbolsInCommentBody
                        self.redisClient.set(`comment:${comment.id}`, comment);
                    });
                });
            });
        });
        this.redisClient.psubscribe('__keyspace@0__:rawComment*');
    }

    preserveSymbolsInCommentBody(comment, cback) {
        const self = this;
        self.preserveUrlsInCommentBody(comment, () => {
            self.preserveStockSymbolsInCommentBody(comment, () => { // JWW stopping - fix so this should find coin symbols too
                if (cback) cback();
            });
        });
    }

    preserveUrlsInCommentBody(comment, cback) { // alters comment in-place
        const self = this;
        // This function uses regex to locate urls within the comment body, then temporarily stores those URLs in comment.pendingSymbols (not saved to redis).
        // It then replaces the URL strings within comment.body with a "urlUid" string (which natural.js will respect as a single token - already "stemmed").
        // The comment.body can then be tokenized and stemmed in extractWordSequences without malforming the URL or interpreting it as multiple tokens.
        // After extractWordSequences has completed the word isolation logic (see "reducedTokensToStems") - the URLs can be re-injected at their original location within
        // comment.body (by doing a string replace against the urlUid that was originally assigned for each URL). urlUid in format `comment${number}` will not be altered by natural js (porter stemmer).
        let commentBody = `${comment.body}`; // We will preserve untouched body text for rendering, and format a temporary local copy for this function's URL extraction logic
        const foundUrlsFirstPass = commentBody.match(urlRegex({strict: false}));
        if (!foundUrlsFirstPass) {
            if (cback) cback();
            return;
        }

        // 1. Perform some alterations to the commentBody that will better support our regex based URL extraction below.
        // Normalize whitespace
        commentBody = commentBody.replace(/\u{2800}/gum, ' '); // \u{2800} is the unicode braile 0 dot symbol (looks like a space)
        // Convert markdown links to a raw link string. urlRegex mistakes format [http://foo.com](http://foo.com/bar/baz) for a single link.
        commentBody = commentBody.replace(/\[(.(?!\s))+\]\(/gm, '('); // https://regexr.com/5q85i - converts [http://foo.com](http://foo.com/bar/baz) to (http://foo.com/bar/baz)
        // next, we need to convert all urls wrapped in parenthesis/brackets (whether they were leftover from MD conversion above, or commenter intentionally put in parenths).
        // ulrRegex mistakes the trailing ) for part of the url identifies 'foo bar (http://foo.com/bar/baz)' for having link: http://foo.com/bar/baz)
        const foundUrlsSecondPass = commentBody.match(urlRegex({strict: false}));
        if (!foundUrlsSecondPass) {
            if (cback) cback();
            return;
        }
        foundUrlsSecondPass.forEach((thisSecondPassUrl) => {
            if (/\)|\]$/.test(thisSecondPassUrl)) { // https://regexr.com/5q85i
                // found a trailing parenth/bracket. Confirm there was originally an opening before stripping them both from commentBody
                const thisSecondPassUrlNoClosing = thisSecondPassUrl.slice(0, -1);
                commentBody = commentBody.replace('['+thisSecondPassUrl, thisSecondPassUrlNoClosing);
                commentBody = commentBody.replace('('+thisSecondPassUrl, thisSecondPassUrlNoClosing);
            }
        });

        // 2. Now we are ready to make a final pass at foundUrls and then replace all found URLs with our urlUid placeholders
        const foundUrls = commentBody.match(urlRegex({strict: false}));
        if (!foundUrls) {
            if (cback) cback();
            return;
        }

        // console.log(`Found ${foundUrls.length} urls in comment:${comment.id}`);
        // comment.originalBody = `${comment.body}`; // Sometimes useful to preserve untouched body on comment object for debugging
        const urlSymbolSearchPromises = [];
        foundUrls.forEach((thisUrl) => {
            urlSymbolSearchPromises.push(new Promise( (resolve, reject) => {
                // Generate a symbol key from this URL and see if it already exists in redis. If not, create now.
                let normalizedUrl = urlNormalize(thisUrl);
                const symbolKey = `symbol:url:${normalizedUrl}`; // `symbol:stock:gme`
                const tokenSymbolResult = {token: thisUrl, normalizedToken: normalizedUrl, symbolKey: symbolKey, matchedSymbol: null}
                self.redisClient.get(symbolKey, (symbol) => {
                    if(symbol) {
                        // now that we have done a very basic symbol match against our redis key pattern, we will confirm the match by passing this token
                        // into the symbols customizable match function.
                        const isMatch = symbolModel.execMatch(symbol, thisUrl, true);
                        if(!isMatch) {
                            resolve(tokenSymbolResult);
                            return;
                        }
                        // console.log(`comment:${comment.id} contained word ${thisToken} which matched an existing symbol ${symbolKey}`);
                        tokenSymbolResult.matchedSymbol = symbol;
                        resolve(tokenSymbolResult);
                    } else {
                        // Symbol object for this URL does not yet exist, create and save it now.
                        // Attempt to generate a symbol name by getting the domain only from the link. ie: reddit.com
                        let symbolName = normalizedUrl.replace(/http(s)*:\/\/(www\.)*/, ''); // https://regexr.com/5q8tl
                        const firstSlashIndex = symbolName.indexOf('/');
                        if (firstSlashIndex !== -1) symbolName = symbolName.slice(0, firstSlashIndex);
                        const newSymbolObj = symbolModel.createSymbolObject({
                            name: symbolName || 'link', // name is required, so provide a fallback
                            symbol: normalizedUrl,
                            type: 'url'
                        });
                        self.redisClient.set(symbolKey, newSymbolObj, () => {
                            console.log(`Created new URL symbol object for ${symbolKey}`);
                            tokenSymbolResult.matchedSymbol = newSymbolObj;
                            resolve(tokenSymbolResult);
                        });
                    }
                });
            }));
        });

        Promise.all(urlSymbolSearchPromises).then((tokenSymbolResults) => {
            let idIncrement = 0;
            tokenSymbolResults.forEach((tokenSymbolResult) => {
                if (tokenSymbolResult.matchedSymbol) {
                    const thisUrlUid = `url${++idIncrement}symbol`;
                    const thisUrlEscapedForRegex = tokenSymbolResult.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // the string we are matching against needs to be escaped for regex. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
                    const newUrlRegex = new RegExp(thisUrlEscapedForRegex, 'gm'); // remember has to be double escaped cuz it's wrapped in string concat. https://regexr.com/5q5m8
                    comment.body = comment.body.replace(newUrlRegex, thisUrlUid);
                    comment.pendingSymbols[thisUrlUid] = tokenSymbolResult;
                }
            });
            if (cback) cback();
        });
    }

    preserveStockSymbolsInCommentBody(comment, cback) {
        const self = this;
        // Like "preserveUrlsInCommentBody", this command extracts potential stock symbol matches BEFORE the comment body is stemmed/tokenized in "extractWordSequences".
        // This is to preserve symbols like "MVIS" - which would get tokenized to MVI.
        const commentTokens = naturalTokenizer.tokenize(comment.body);
        const tokenSymbolSearchPromises = [];
        commentTokens.forEach((thisToken, thisTokenIndex) => {
            tokenSymbolSearchPromises.push(new Promise( (resolve, reject) => {
                const symbolKey = `symbol:stock:${thisToken.toUpperCase()}`; // `symbol:stock:GME` - stock symbol object keys always make the ticker caps
                const tokenSymbolResult = {token: thisToken, normalizedToken: thisToken.toUpperCase(), symbolKey: symbolKey, matchedSymbol: null};
                let precedingToken = null;
                if (thisTokenIndex !== 0) precedingToken = commentTokens[thisTokenIndex-1];

                // Step 1: eliminate this word based on quick basic rules
                if (thisToken.length === 0 || thisToken.length > 5) { // Enforce a max length for stock symbols
                    resolve(tokenSymbolResult);
                    return;
                }
                const isAlpha = /^[A-Za-z]+$/.test(thisToken);
                if (!isAlpha) { // Only allow alphabet chars
                    resolve(tokenSymbolResult);
                    return;
                }
                // Step 2: Generate a symbol key from this word and see if it exists in redis. If it does, we still can't conclude this word matches a symbol (because
                // we only looked up its stemmed token representation). The custom match function will have more specific logic that we must now test.
                self.redisClient.get(symbolKey, (symbol) => {
                    if(!symbol) {
                        resolve(tokenSymbolResult);
                        return;
                    }
                    // now that we have done a very basic symbol match against our redis key pattern, we will confirm the match by passing this token
                    // into the symbols customizable match function.
                    let isMatch = symbolModel.execMatch(symbol, thisToken, true);
                    if(!isMatch && precedingToken === '$') { // We manually support passing $ to the custom match function if a "$" token preceeded this stock symbol. Some custom match functions will require $ to be preset (when tokens withou $ are too too ambiguous)
                        isMatch = symbolModel.execMatch(symbol, `$${thisToken}`, true);
                    }
                    if(!isMatch) {
                        resolve(tokenSymbolResult);
                        return;
                    }
                    // console.log(`comment:${comment.id} contained word "${thisToken}" which matched an existing symbol ${symbolKey}`);
                    tokenSymbolResult.matchedSymbol = symbol;
                    resolve(tokenSymbolResult);
                });
            })); // end tokenSymbolSearchPromises.push
        }); // end commentTokens.forEach

        Promise.all(tokenSymbolSearchPromises).then((tokenSymbolResults) => {
            let idIncrement = 0;
            tokenSymbolResults.forEach((tokenSymbolResult) => {
                if (tokenSymbolResult.matchedSymbol) {
                    const thisStockUid = `stock${++idIncrement}symbol`;
                    const stockSymbolRegex = new RegExp(`\\b${tokenSymbolResult.token}\\b`, 'gim'); // https://regexr.com/5rrbf
                    comment.body = comment.body.replace(stockSymbolRegex, thisStockUid);
                    comment.pendingSymbols[thisStockUid] = tokenSymbolResult;
                }
            });
            if (cback) cback();
        });

    } // end preserveStockSymbolsInCommentBody

    extractWordSequences(commentData, cback) {
        const self = this;
        /////////////////
        // Form the following object from the comment body: 'Jim Cramer puts milk first in his bowl'
        // const tokensToStems = [
        //     {
        //         tokenized: ['Jim', 'Cramer'], // tokenized bigram
        //         stemmed: ['jim', 'cramer'] // same bigram after stemmed too
        //     },
        //     { // we currently only save singleWordSymbols/bigrams/trigrams to redis, but since a tokenized sequence is often shortened after stemming, our token sequences will include all the way up to 6 tokens.
        //         tokenized: ['First', 'in', 'his', 'bowl'],
        //         stemmed: ['first', 'bowl']
        //     },
        //     // etc...
        // ];
        // We use this method because we want to save the raw word sequence that resulted in a new redis word object (word:symbol, word:bigram, word:trigram) for comparison later.
        // To use the example above, the 2nd entry would result in a new redis object with key "word:bigram:first_bowl" but the full raw word sequence is what would be used to match against symbols (using custom match functions).
        const maxNgram = 3; // We only save word sequences to redis up to 3 words max (stemmed)
        const tokensToStems = [];
        [1,2,3,4,5,6].forEach((thisN) => {
            const theseTokenized = naturalNGrams.ngrams(commentData.body, thisN);
            theseTokenized.forEach((thisTokenized) => {
                const tokensStemmed = natural.PorterStemmer.tokenizeAndStem(thisTokenized.join(' '));
                if (!tokensStemmed) return;
                tokensToStems.push({
                    tokenized: thisTokenized,
                    stemmed: tokensStemmed
                });
            })
        });
        // Now transform the above object into the following:
        // {
        //     'first_bowl': ['First in his bowl', 'First is the bowl and', 'A First is in bowling', ..etc],
        //     etc...
        // }
        // This reduces down all the token sequences into uniform stem keys (these stem keys (sequenceKey) are used when setting/getting word: objects to redis)
        const reducedTokensToStems = {};
        tokensToStems.forEach((thisTokenToStem) => {
            if (thisTokenToStem.stemmed.length > maxNgram) return; // The outcome from this stemming resulted in too long a sequence. Discard.
            const sequenceKey = thisTokenToStem.stemmed.join('_!!_'); // _!!_ is the hashHype word delimeter
            reducedTokensToStems[sequenceKey] = reducedTokensToStems[sequenceKey] || [];
            reducedTokensToStems[sequenceKey].push(thisTokenToStem.tokenized);
        });
        //////////////////

        // Now that we reduced comment body to token sequences, loop through and determine if any are symbols, and save all to redis as new words objects
        const pendingSymbolUids = Object.keys(commentData.pendingSymbols);
        const wordSavePromises = [];
        for (let [sequenceKey, allRawTokenSequences] of Object.entries(reducedTokensToStems)) {
            allRawTokenSequences = [...new Set(allRawTokenSequences)]; // remove dups
            let stemSequence = sequenceKey.split('_!!_'); // _!!_ is the hashHype word delimeter.

            // Now we will add all preserved symbols (URLs, stocks) back into comment.body, this stemSequence, and each allRawTokenSequences before proceeding to save the words.
            let symbolUidsInStemSequence = stemSequence.filter(stemmedToken => pendingSymbolUids.includes(stemmedToken));
            const symbolsInWord = []; // (symbol object keys) so they can be added to word object (hasSymbols) during creationg below
            if (symbolUidsInStemSequence.length > 0) {
                symbolUidsInStemSequence = [...new Set(symbolUidsInStemSequence)], // remove dups
                symbolUidsInStemSequence.forEach((symbolUid) => {
                    const tokenSymbolResult = commentData.pendingSymbols[symbolUid];
                    symbolsInWord.push(tokenSymbolResult.symbolKey);
                    const symbolUidRegex = new RegExp(symbolUid, 'gm');
                    commentData.body = commentData.body.replace(symbolUidRegex, tokenSymbolResult.normalizedToken);
                    sequenceKey = sequenceKey.replace(symbolUidRegex, tokenSymbolResult.normalizedToken);
                    allRawTokenSequences.forEach((thisRawSeq, thisRawSeqIndex) => {
                        thisRawSeq.forEach((thisRawSeqToken, thisRawSeqTokenIndex) => {
                            thisRawSeq[thisRawSeqTokenIndex] = thisRawSeqToken.replace(symbolUidRegex, tokenSymbolResult.normalizedToken);
                        });
                    });
                });
            }

            // Split the token sequence into an array of tokens so we can assign to wordObj.value, and determine the wordObj.type
            stemSequence = sequenceKey.split('_!!_'); // reset this because sequenceKey may have changed while replacing symbolUidsInStemSequence
            let wordType = 'word';
            if (stemSequence.length === 2) wordType = 'bigram';
            if (stemSequence.length === 3) wordType = 'trigram';

            // Check if this word should be discard from relevancy training or by other rules.
            if ( self.isDiscardWord(sequenceKey, wordType, symbolsInWord) ) continue;

            const newWordObject = self.newWordEntity({
                type: wordType,
                value: stemSequence, // sequence array - NOT stringified
                rawWords: allRawTokenSequences,
                hasSymbols: symbolsInWord // array of symbol keys
            });

            const wordRef = self.newWordRefEntity({ // Store a wordRef object on the comment
                word: sequenceKey,
                type: wordType,
                hasSymbols: symbolsInWord
            });
            commentData.words.push(wordRef);

            wordSavePromises.push(new Promise( (resolve, reject) => {
                const redisWordKey = self.generateWordEntityKey(newWordObject);
                self.redisClient.get(redisWordKey, (gotWord) => {
                    let saveWordObject = newWordObject;
                    if (gotWord) {
                        saveWordObject = gotWord;
                        saveWordObject.rawWords = saveWordObject.rawWords.concat(newWordObject.rawWords);
                        saveWordObject.rawWords = saveWordObject.rawWords.filter((v, i, a) => a.indexOf(v) === i); // remove dups
                        saveWordObject.hasSymbols = saveWordObject.hasSymbols.concat(newWordObject.hasSymbols);
                        saveWordObject.hasSymbols = [...new Set(saveWordObject.hasSymbols)]; // remove dups
                    }

                    // Save the word object to redis
                    self.redisClient.set(redisWordKey, saveWordObject);

                    // Save this word to it's WordToCommentsIndex (creating one if it does not yet exist)
                    self.registerWordToCommentsIndex(saveWordObject.value.join('_!!_'), commentData.id, () => { // this needs to be done before the rpush because of topCommentsStats logic
                        self.addFoundAtTstampForWord(redisWordKey, () => {
                            resolve(); // finally, we can resolve this wordSavePromise
                        });
                    });
                }); // end self.redisClient.get(redisWordKey
            })); // end wordSavePromises.push
        } // end for reducedTokensToStems loop

        Promise.all(wordSavePromises).then(() => {
            if(cback) cback();
        });
    } //end extractWordSequences

    registerWordToCommentsIndex(wordString, commentId, cback) { // a comment index (index:wordToComments:foo_bar) is an array holding comment ids
        const self = this;
        const thisIndexKey = `index:wordToComments:${wordString}`;
        self.redisClient.get(thisIndexKey, (gotWordIndex) => {
            let wordToCommentsIndex = [];
            if (gotWordIndex) wordToCommentsIndex = gotWordIndex;
            if (wordToCommentsIndex.indexOf(commentId) === -1) wordToCommentsIndex.push(commentId);
            self.redisClient.set(thisIndexKey, wordToCommentsIndex, () => {
                if (cback) cback();
            });
        });
    }

    addFoundAtTstampForWord(redisWordKey, cback) {
        const self = this;
        // All "foundAt" tstamps are stored to their own redis list at key: word:foo_!!_bar:foundAt
        const foundAtListKey = `${redisWordKey}:foundAt`; // rpush auto creates list if it does not already exist
        self.redisClient.rpush(foundAtListKey, [Date.now()], (listLength) => {
            if (cback) cback(); // go ahead and return to caller, we don't need to wait on asyn cleanup tasks below

            // Now trim this "foundAt" list - remove all tstamps which are older than 24hrs old (self.trackWordsFor). For performance,
            // we don't want to run this logic every single time there is a word re-occurance. We establish a vague threshold for max list length.
            const maxListLength = self.trackWordsFor / 5000; // self.trackWordsFor is ms. Let's estimate that once we have enough tstamps to account a word recurring every 5 seconds, we start trim logic.
            if (listLength < maxListLength) return;
            console.log(`A redis list (${foundAtListKey}) will now be trimmed of all tstamps older than ${self.trackWordsFor/3600000}hrs...`);
            self.redisClient.lrange(foundAtListKey, 0, -1, (allFoundAtTstamps) => {
                let trimStart = 0; // the index in list at which tstamps stop being too old. These lists are sorted ascending.
                allFoundAtTstamps.some((thisTstamp, thisTstampIndex) => {
                    const isOldTstamp = Date.now() - commentData.createdUtc > self.trackWordsFor;
                    if (!isOldTstamp) return true; // break from loop. We have looped through all the old tstamps.
                    trimStart = thisTstampIndex;
                });
                if (trimStart === 0) return;
                self.redisClient.ltrim(foundAtListKey, trimStart, -1);
                console.log(`Trimmed ${trimStart} items from redis list: ${foundAtListKey}`)
            });
        }); // end self.redisClient.rpush(foundAtListKey
    }

    syncTrainingNotRelevant() {
        // This function gets training:notRelevant from redis (used to ignore word combos found in comments), and adds
        // a keyspace listener so local data is always synced with redis.
        const self = this;
        this.redisClient.get('training:notRelevant', (trainingObj) => {
            if (!trainingObj) return;
            self.trainingNotRelevant = trainingObj;
        });
        if (self.trainingNotRelevantIsSynced) return;
        self.trainingNotRelevantIsSynced = true;
        self.redisClient.on('message', (channel, message) => {
            if (channel === '__keyspace@0__:training:notRelevant') self.syncTrainingNotRelevant();
        });
        self.redisClient.subscribe('__keyspace@0__:training:notRelevant');
    }

    isDiscardWord(wordString, wordType, symbolsInWord = []) {
        // this process includes rules around which comments should be included in trend analysis. Ie: comments that are too long... comments that look like bots or spam, etc.
        let shouldDiscard = false;

        // If is a single word that includes no symbols
        if (wordType === 'word' && symbolsInWord.length === 0) {
            shouldDiscard = true;
            return shouldDiscard;
        }

        // If word is an empty string
        if (wordString.replace(/\s|\u{2800}/gum, '').length === 0) {
            shouldDiscard = true;
            return shouldDiscard;
        }

        // If word has been marked as not relevant
        if (this.trainingNotRelevant) {
            const notRelWordIndex = this.trainingNotRelevant.words.findIndex((thisWord) => thisWord.word === wordString);
            if (notRelWordIndex !== -1) shouldDiscard = true;
            return shouldDiscard;
        }

        return shouldDiscard;
    }

    newWordEntity(initial = {}) { // Must provide value, and type
        // returns an initial state for a new word, bigram, trigram object
        return {
            value: initial.value, // an array of words (word sequence). length 1 for type word, and for 2 bi and 3 tri gram
            rawWords: initial.rawWords || [], // array of arrays of single strings. (as-commented after tokenized) Each matching this word (though not necc. by case or exact match)
            type: initial.type, // 'word', 'bigram', 'trigram'
            hasSymbols: initial.hasSymbols || [], // array of symbol object keys ['symbol:stock:gme', etc]
            // foundAt: [] // array of timestamps for every time this entity was found in a raw comment
        }
        // the array of "foundAt" tstamps is stored to it's own redis list at key: word:foo_!!_bar:foundAt
    }

    newWordRefEntity(initial = {}) {
        // returns an initial state for a word ref (used to reference a full word object stored in redis). The word ref objects live on comment objects.
        return {
            word: initial.word, // Stringified version (foo_bar) of what would be the word.value prop on the actual word object. Can be used to form a redis key for word (word:foo_bar)
            type: initial.type, // 'word', 'bigram', 'trigram'
            hasSymbols: initial.hasSymbols || [], // array of symbol object keys ['symbol:stock:gme', etc]
        }
    }

    generateWordEntityKey(word) {
        const wordEntityKey = `word:${word.value.join('_!!_')}`; // _!!_ is the hashHype word delimeter
        return wordEntityKey;
    }

}

const thisExtractor = new ExtractWordsFromComments();
export default ExtractWordsFromComments;
