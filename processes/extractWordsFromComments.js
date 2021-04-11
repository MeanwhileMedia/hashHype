import natural from 'natural';
import urlRegex from 'url-regex';
import urlNormalize from 'normalize-url';
import RedisClient from '../utils/redisClient.js';
import symbolModel from '../utils/objectModels/symbol.js';

import events from 'events';
events.EventEmitter.defaultMaxListeners = Infinity;

class ExtractWordsFromComments {

    // Step 1: strip out insignificant words like "it", "the" (built into PorterStemmer.tokenizeAndStem)
    // Step 2: tokenize and stem every remaining word (built into PorterStemmer.tokenizeAndStem)
    // Step 3: Store word object for every single word that is ALSO a symbol
    // Step 4: Store every bigram to redis as a word object
    // Step 5: Store every trigram to redis as a word object
    // Step 6: Add every found word:symbol, word:bigram, word:trigram, and symbol to the comment object, save to redis.
    // Step 7: As topWordStats continues to produce occurance counts - comments which contain topWords will be pointed accordingly, and maybe trend.

    constructor() {
        const self = this;
        this.redisClient = null;
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
                self.preserveUrlsInCommentBody(comment);
                self.extractWordSequences(comment, () => {
                    let wordsRegistered = 0;
                    comment.words.forEach( (thisWordRef) => {
                        self.registerWordToCommentsIndex(thisWordRef.word, comment.id, () => {
                            wordsRegistered++;
                            if (wordsRegistered >= comment.words.length) {
                                self.redisClient.set(`comment:${comment.id}`, comment);
                            }
                        })
                    });
                });
            });
        });
        this.redisClient.psubscribe('__keyspace@0__:rawComment*'); // flow for comments is rawComment -> newComment -> comment
    }

    preserveUrlsInCommentBody(comment) { // alters comment in-place
        // This function uses regex to locate urls within the comment body, then temporarily stores those URLs in comment.pendingUrls (not saved to redis).
        // It then replaces the URL strings within comment.body with a "urlUid" string (which natural.js will respect as a single token - already "stemmed").
        // The comment.body can then be tokenized and stemmed in extractWordSequences without malforming the URL or interpreting it as multiple tokens.
        // After extractWordSequences has completed the word isolation logic (see "reducedTokensToStems") - the URLs can be re-injected at their original location within
        // comment.body (by doing a string replace against the urlUid that was originally assigned for each URL). urlUid in format `comment${number}` will not be altered by natural js (porter stemmer).
        let commentBody = `${comment.body}`; // We will preserve untouched body text for rendering, and format a temporary local copy for this function's URL extraction logic
        comment.pendingUrls = {};
        const foundUrlsFirstPass = commentBody.match(urlRegex({strict: false}));
        if (!foundUrlsFirstPass) return;

        // 1. Perform some alterations to the commentBody that will better support our regex based URL extraction below.
        // Normalize whitespace
        commentBody = commentBody.replace(/\u{2800}/gum, ' '); // \u{2800} is the unicode braile 0 dot symbol (looks like a space)
        // Convert markdown links to a raw link string. urlRegex mistakes format [http://foo.com](http://foo.com/bar/baz) for a single link.
        commentBody = commentBody.replace(/\[(.(?!\s))+\]\(/gm, '('); // https://regexr.com/5q85i - converts [http://foo.com](http://foo.com/bar/baz) to (http://foo.com/bar/baz)
        // next, we need to convert all urls wrapped in parenthesis/brackets (whether they were leftover from MD conversion above, or commenter intentionally put in parenths).
        // ulrRegex mistakes the trailing ) for part of the url identifies 'foo bar (http://foo.com/bar/baz)' for having link: http://foo.com/bar/baz)
        const foundUrlsSecondPass = commentBody.match(urlRegex({strict: false}));
        if (!foundUrlsSecondPass) return;
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
        if (!foundUrls) return;

        console.log(`Found ${foundUrls.length} urls in comment:${comment.id}`);
        //comment.originalBody = `${comment.body}`; // Sometimes useful to preserve untouched body on comment object for debugging
        let idIncrement = 0;
        foundUrls.forEach((thisUrl) => {
            const thisUrlUid = `url${++idIncrement}`;
            // const thisUrlEscapedForRegex = thisUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\\$&') // the string we are matching against needs to be escaped for regex. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
            // const newUrlRegex = new RegExp(`(^|\\s)(${thisUrlEscapedForRegex})(\\s|(\\.\\s)|$)`, 'gm'); // remember has to be double escaped cuz it's wrapped in string concat. https://regexr.com/5q5m8
            // comment.body = comment.body.replace(newUrlRegex, ` ${thisUrlUid} `);
            const thisUrlEscapedForRegex = thisUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // the string we are matching against needs to be escaped for regex. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
            const newUrlRegex = new RegExp(thisUrlEscapedForRegex, 'gm'); // remember has to be double escaped cuz it's wrapped in string concat. https://regexr.com/5q5m8
            comment.body = comment.body.replace(newUrlRegex, `${thisUrlUid}`);
            let normalizedUrl = urlNormalize(thisUrl);
            comment.pendingUrls[thisUrlUid] = normalizedUrl;
        });
        // console.log('Replaced urls with urlUids:', comment);
    }

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
        const NGrams = natural.NGrams;
        const maxNgram = 3; // We only save word sequences to redis up to 3 words max (stemmed)
        const tokensToStems = [];
        [1,2,3,4,5,6].forEach((thisN) => {
            const theseTokenized = NGrams.ngrams(commentData.body, thisN);
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
        const allNewWordObjects = {};
        const symbolMatchPromises = []; // runs promise.all first
        const wordSavePromises = []; // runs second
        for (let [sequenceKey, allRawTokenSequences] of Object.entries(reducedTokensToStems)) {
            // Now we will add URLs back into each word sequence (and comment.body) before proceeding to extract symbols and save the words.
            for (const [urlUid, url] of Object.entries(commentData.pendingUrls)) {
                const urlUidRegex = new RegExp(urlUid, 'gm');
                commentData.body = commentData.body.replace(urlUidRegex, url);
                sequenceKey = sequenceKey.replace(urlUidRegex, url);
                allRawTokenSequences.forEach((thisRawSeq, thisRawSeqIndex) => {
                    let correctedSequence = [];
                    thisRawSeq.forEach((thisRawSeqToken, thisRawSeqTokenIndex) => {
                        thisRawSeq[thisRawSeqTokenIndex] = thisRawSeqToken.replace(urlUidRegex, url);
                    });
                });
            }

            // Check if this word should be discard from relevancy training or by other rules.
            if (self.isDiscardWord(sequenceKey)) continue;

            // Ready to proceed in forming a newWordEntity and checking for symbols
            const stemSequence = sequenceKey.split('_!!_'); // _!!_ is the hashHype word delimeter
            let wordType = 'word';
            if (stemSequence.length === 2) wordType = 'bigram';
            if (stemSequence.length === 3) wordType = 'trigram';

            const newWordObject = self.newWordEntity({
                type: wordType,
                value: stemSequence, // sequence array - NOT stringified
                rawWords: [...new Set(allRawTokenSequences)], // remove dups
                hasSymbols: [] // will fill this array if symbols are found during our symbolMatchPromises
            });
            const redisWordKey = self.generateWordEntityKey(newWordObject);
            allNewWordObjects[redisWordKey] = newWordObject;

            const saveWordToRedis = (thisWordObject, saveWordToRedisCback) => {
                const redisWordKey = self.generateWordEntityKey(thisWordObject);
                self.redisClient.get(redisWordKey, (gotWord) => {
                    let saveWordObject = thisWordObject;
                    if (gotWord) {
                        saveWordObject = gotWord;
                        saveWordObject.rawWords = saveWordObject.rawWords.concat(thisWordObject.rawWords);
                        saveWordObject.rawWords = saveWordObject.rawWords.filter((v, i, a) => a.indexOf(v) === i); // remove dups
                        saveWordObject.hasSymbols = saveWordObject.hasSymbols.concat(thisWordObject.hasSymbols);
                        saveWordObject.hasSymbols = [...new Set(saveWordObject.hasSymbols)]; // remove dups
                    }
                    saveWordObject.foundAt.unshift(Date.now()); // keep track of each time this word occured in a new comment
                    // Save the word object to redis
                    self.redisClient.set(redisWordKey, saveWordObject, () => {
                        if (saveWordToRedisCback) saveWordToRedisCback();
                    });
                });
            }

            // Now that we have the comment broken down into word sequences (singe, bi/trigrams) we will attempt to identify symbols within those sequences.
            // Because symbols, by nature, are a single token, we only run the "isWordSymbol" on type: single word objects. If a word matches a symbol, then we will
            // loop through the bi/trigrams, check for that single token symbol within it's sequence, and if found, save a symbolRef on the comment for the bi/trigram (instead of wordRef).
            if (wordType === 'word') {
                // if this was a single token word sequence we must now confirm a symbol match (we don't store single words otherwise)
                symbolMatchPromises.push(new Promise( (resolve, reject) => {
                    self.isWordSymbol(newWordObject, (isSymbol) => { // isSymbol arg is object {isSymbol: bool, symbolKey: string, wordObj: the word obj that matched a symbol}
                        if (!isSymbol.isSymbol) {
                            resolve();
                            return;
                        }
                        const wordThatMatchedSymbol = isSymbol.wordObj.value[0]; // we want a string here. Since we know this is a single word sequence, we can just grab index 0 from word.value.
                        console.log(`A single word (${wordThatMatchedSymbol}) is a symbol on comment: ${commentData.id}`);
                        // This single word is confirmed to be a symbol:
                        // 1. store a symbolRef object on the comment for this single word
                        const wordRef = self.newWordRefEntity({
                            word: wordThatMatchedSymbol,
                            hasSymbols: [isSymbol.symbolKey]
                        });
                        commentData.words.push(wordRef);
                        // 2. store the symbol key to the word.hasSymbols array too
                        isSymbol.wordObj.hasSymbols.push(isSymbol.symbolKey);
                        // 3. Set a promise to save this single word object to redis (we ONLY save single words when they are matched with a symbol)
                        wordSavePromises.push(new Promise( (wordSaveResolve, wordSaveReject) => {
                            saveWordToRedis(isSymbol.wordObj, wordSaveResolve);
                        }));
                        // 4. Loop through commentData.words to test bi/trigrams for inclusion of this symbol token in their word sequence.
                        const wordThatMatchedSymbolEscapedForRegex = wordThatMatchedSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\\$&') // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
                        const wordThatMatchedSymbolRegex = new RegExp(`(_|^)(${wordThatMatchedSymbolEscapedForRegex})(_|$)`); // https://regexr.com/5pnvm
                        commentData.words.forEach((thisCommentWordRef) => {
                            const matchIndex = thisCommentWordRef.word.search(wordThatMatchedSymbolRegex);
                            if (matchIndex !== -1 && thisCommentWordRef.word !== wordThatMatchedSymbol) {
                                console.log(`A word sequence (${thisCommentWordRef.word}) contained a symbol (${wordThatMatchedSymbol}) on comment: ${commentData.id}`);
                                thisCommentWordRef.hasSymbols.push(isSymbol.symbolKey); // update the wordRef hasSymbols (wordRef stored on comment)
                                allNewWordObjects[`word:${thisCommentWordRef.word}`].hasSymbols.push(isSymbol.symbolKey); // AND this word object hasSymbols
                            }
                        });
                        resolve();
                    });
                }));
            } else {
                // All bi/trigram word types will be saved to redis AFTER the symbol lookup logic is complete (whether they contain symbols or not)
                const wordRef = self.newWordRefEntity({ // Store a wordRef object on the comment
                    word: sequenceKey,
                    hasSymbols: [] // will fill this array if symbols are found during our symbolMatchPromises
                });
                commentData.words.push(wordRef);
                wordSavePromises.push(new Promise( (resolve, reject) => {
                    saveWordToRedis(newWordObject, resolve);
                }));
            }
        } // end for loop

        Promise.all(symbolMatchPromises).then(() => {
            Promise.all(wordSavePromises).then(() => {
                if(cback) cback();
            });
        });

        delete commentData.pendingUrls; // this was only a temporary prop created by preserveUrlsInCommentBody function
    } //end extractWordSequences

    isWordSymbol(wordObject, cback) { // cback returns {isSymbol: bool, symbolKey: string}
        const self = this;
        self.checkForUrlSymbol(wordObject, (isUrlSymbol) => {
            if (isUrlSymbol.isSymbol) {
                if (cback) cback(isUrlSymbol);
                return;
            }
            //JWW TODO - check for emoji symbols
            self.checkForStockSymbol(wordObject, (isStockSymbol) => {
                if (cback) cback(isStockSymbol);
            });
        });
    }

    checkForUrlSymbol(wordObj, cback) {
        const self = this;
        cback = cback || function(){};
        const wordString = wordObj.value.join('_!!_'); // _!!_ is the hashHype word delimeter
        const symbolKey = `symbol:url:${wordString}`

        const wordHasUrl = urlRegex({exact: true}).test(wordString);
        if (!wordHasUrl) {
            // console.log(`Word is not URL: ${wordString}`);
            cback({isSymbol: false, symbolKey: symbolKey, wordObj: wordObj});
            return;
        }

        // Now that we confirmed this word sequence has a URL in it, check if this symbol exists in redis. if not, save a new symbol object now.
        this.redisClient.get(symbolKey, (symbol) => {
            if (symbol) {
                // Symbol already exists and we have nothing to merge in at this point.
                console.log(`Found URL symbol already exists in redis: ${symbolKey}`);
                if (cback) cback({isSymbol: true, symbolKey: symbolKey, wordObj: wordObj});
                return;
            }
            // Symbol object for this URL does not yet exist, create and save it now.
            // Attempt to generate a symbol name by getting the domain only from the link. ie: reddit.com
            let symbolName = wordString.replace(/http(s)*:\/\/(www\.)*/, ''); // https://regexr.com/5q8tl
            const firstSlashIndex = symbolName.indexOf('/');
            if (firstSlashIndex !== -1) symbolName = symbolName.slice(0, firstSlashIndex);
            const newSymbolObj = symbolModel.createSymbolObject({
                name: symbolName || 'link', // name is required, so provide a fallback
                symbol: wordString,
                type: 'url'
            });
            console.log(`Created new URL symbol object for ${symbolKey}`); //, newSymbolObj, wordObj);
            self.redisClient.set(symbolKey, newSymbolObj, () => {
                if (cback) cback({isSymbol: true, symbolKey: symbolKey, wordObj: wordObj});
            });
        });
    }

    checkForStockSymbol(wordObj, cback) { // cback returns {isSymbol: bool, symbolKey: string}
        const self = this;
        cback = cback || function(){};
        const wordString = wordObj.value.join('_!!_'); // _!!_ is the hashHype word delimeter

        // Step 1: eliminate this word based on quick basic rules
        // Enforce a max length for stock symbols
        if (wordString.length === 0 || wordString.length > 5) {
            cback({isSymbol: false});
            return;
        }
        // Only allow alphabet chars (and a $ char if it is the first char)
        const isAlpha = /^[$]*[A-Za-z_]+$/.test(wordString);
        if (!isAlpha) {
            cback({isSymbol: false});
            return;
        }

        // Step 2: Generate a symbol key from this word and see if it exists in redis. If it does, we still can't conclude this word matches a symbol (because
        // we only looked up its stemmed token representation). The custom match function will have more specific logic that we must now test.
        const symbolKey = `symbol:stock:${wordString}`; // `symbol:stock:gme`
        this.redisClient.get(symbolKey, (symbol) => {
            if(!symbol) {
                cback({isSymbol: false});
                return;
            }
            //console.log(`A possible symbol match was found (${wordString} => ${symbol.symbol}). Will now run through match function to confirm.`)
            const funcdSymbolData = symbolModel.execGet(symbol); // When matching this word agains the symbol, we pass symbol data generated from the custom symbol.get logic.
            const wordPassedSymbolMatch = wordObj.rawWords.some((rawWordSeq) => {
                const rawWordSeqString = rawWordSeq.join(' '); // our custom match functions expects this to be a spaced string of tokens
                const isMatch = symbolModel.execMatch(funcdSymbolData, rawWordSeqString, true);
                if (isMatch) return true; // break from loop. We only need to confirm 1 match
            });
            cback({isSymbol: wordPassedSymbolMatch, symbolKey: symbolKey, wordObj: wordObj});
        });
    }

    registerWordToCommentsIndex(wordString, commentId, cback) { // a comment index (index:wordToComments:) is an array holding comment ids
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

    isDiscardWord(wordString) { // word is in array form [symbolWord] or [bigram,word] etc
        // this process includes rules around which comments should be included in trend analysis. Ie: comments that are too long... comments that look like bots or spam, etc.
        let shouldDiscard = false;

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
            foundAt: [] // array of timestamps for every time this entity was found in a raw comment
        }
    }

    newWordRefEntity(initial = {}) {
        // returns an initial state for a word ref (used to reference a full word object stored in redis). The word ref objects live on comment objects.
        return {
            word: initial.word, // Stringified version (foo_bar) of what would be the word.value prop on the actual word object. Can be used to form a redis key for word (word:foo_bar)
            hasSymbols: initial.hasSymbols || [], // array of symbol object keys ['symbol:stock:gme', etc]
            pointsEarned: 0 // so an individual wordRef owner (like a comment object) can track how many points this word earned for it STARTING when the comment was created. (not timebucketed)
        }
    }

    generateWordEntityKey(word) {
        const wordEntityKey = `word:${word.value.join('_!!_')}`; // _!!_ is the hashHype word delimeter
        return wordEntityKey;
    }

}

const thisExtractor = new ExtractWordsFromComments();
export default ExtractWordsFromComments;
