import util from 'util';
import natural from 'natural';
import {parse} from 'node-html-parser';
import urlRegex from 'url-regex';
import urlNormalize from 'normalize-url';
import emojiUnicodeRegex from 'emojibase-regex';
import emojiShortcodeRegex from 'emojibase-regex/shortcode';
import yargs from 'yargs';
import RedisClient from '../utils/redisClient.js';
import commentModel from '../utils/objectModels/comment.js';
import wordModel from '../utils/objectModels/word.js';
import symbolModel from '../utils/objectModels/symbol.js';
import stopWords from '../utils/stopWords.js';

// import events from 'events';
// events.EventEmitter.defaultMaxListeners = Infinity;

const argv = yargs(process.argv.slice(2)).argv;

const naturalWordTokenizer = new natural.WordTokenizer(); // is object (naturalWordTokenizer.tokenize(string)
const naturalWordTokenizerPreserveContractions = new natural.RegexpTokenizer({pattern: /[^A-Za-zА-Яа-я0-9_'’]/}); // IF MODIFYING TO A GLOBAL REPLACE. a slightly modified natural WordTokenizer which adds "'" to non-split chars. https://regexr.com/69idj  https://github.com/NaturalNode/natural/blob/master/lib/natural/tokenizers/regexp_tokenizer.js#L86

const naturalNGrams = natural.NGrams; // is object (naturalNGrams.ngrams(string or array)) - Can runs through a tokenizer when passed a string.
naturalNGrams.setTokenizer(naturalWordTokenizerPreserveContractions);

const naturalStemmer = natural.PorterStemmer; // is object (naturalStemmer.stem(string))
const naturalNormalizer = natural.normalize; // is funcion (naturalNormalizer(array or string))

const nodeHtmlParser = parse; // because their naming sucks

class ExtractWordsFromComments {

    // Step 1: strip out insignificant words like "it", "the" (built into stemmer)
    // Step 2: tokenize and stem every remaining word
    // Step 3: Store word object for every single word that is ALSO a symbol
    // Step 4: Store every bigram to redis as a word object
    // Step 5: Store every trigram to redis as a word object
    // Step 6: As topWordStats continues to produce occurance counts - comments which contain topWords will be pointed accordingly, then produce 2dGrams.

    constructor() {
        const self = this;
        this.redisClient = null;

        // Set "newCommentsMustContainSymbol" to true and every new comment processed will discared immediately after preserveSymbolsInCommentBody. It's words won't be extracted, earn foundAt timestamps.
        // The comment object will not be saved to DB and therfore never make it to topCommentStats to compete as a topComment. This saves a lot of resources and may make the
        // hashHype algorithm more accurate by only allowing it to count word combos in comments that are in a symbol's context.
        this.newCommentsMustContainSymbol = true;

        this.extractRawCommentQueue = []; // We only extract words from comments 1 at a time. It has complex async logic and when many extractions overlap memory can overflow.
        this.extractRawCommentQueueWarnLength = 500; // when do we start logging warnings that the queue is too large
        this.extractRawCommentQueueClearLength = 1000; // when do we clear the queue so that new incoming comments cut to the front
        this.cancelCurrentExtractRawCommentQueue = () => {}; // set below in processNextQueuedNewRawCommentExtraction. This is a safety switch that our code may call anytime we need to flush out the queue to keep this process healthy.

        this.isProcessingExtractRawCommentQueue = false; // will be false only when extractRawCommentQueue has been fully emptied
        this.queueSizeCountInterval = null; // for logging queue progress
        this.queueSizeCountIntervalLength = 5000;
        this.initQueueSizeCountInterval();

        this.commentCount = {}; // {twitter: 762, reddit: etc...} for logging comment count every 5 seconds
        this.commentCountInterval = null;
        this.commentCountIntervalLength = 5000;
        this.commentCountDiscardedNoSymbol = 0; // a separate counter just for logging how many comments were discarded because newCommentsMustContainSymbol = true
        this.initCommentCountInterval();

        console.log('A new extractWordsFromComments process has just started...');
        this.initRedisClient(() => {
            self.syncTrainingNotRelevant();
            self.initKeyspaceSubscriptions();
        });
    }

    initQueueSizeCountInterval() {
        const self = this;
        if (self.queueSizeCountInterval) return;
        self.queueSizeCountInterval = setInterval(() => {
            console.log(`extractRawCommentQueue current length: ${this.extractRawCommentQueue.length}`);
            if (this.extractRawCommentQueue.length >= this.extractRawCommentQueueWarnLength) {
                console.warn(`extractRawCommentQueue is falling behind!`)
            }
            if (this.extractRawCommentQueue.length >= this.extractRawCommentQueueClearLength) {
                console.error(`extractRawCommentQueue has gotten too large and will now be cleared!`);
                self.extractRawCommentQueue = [];
                // We must also be sure to manually cancel any active queue.
                self.cancelCurrentExtractRawCommentQueue();
                self.isProcessingExtractRawCommentQueue = false;
            }
        }, self.queueSizeCountIntervalLength);
    }

    initCommentCountInterval() {
        const self = this;
        if (self.commentCountInterval) return;
        self.commentCountInterval = setInterval(() => {
            for (let [commentSource, commentCount] of Object.entries(self.commentCount)) {
                console.log(`Processed ${commentCount} new ${commentSource} comments in the last ${self.commentCountIntervalLength/1000} seconds.`);
                self.commentCount[commentSource] = 0;
            }
            console.log(`Discarded ${self.commentCountDiscardedNoSymbol} comments with 0 symbols in the last ${self.commentCountIntervalLength/1000} seconds.`)
            self.commentCountDiscardedNoSymbol = 0;
        }, self.commentCountIntervalLength);
    }

    initRedisClient(cback) {
        const self = this;
        self.redisClient = new RedisClient({
            onConnect: () => {
                console.log('Connected to locally hosted redis DBs for word extractor class.');
                self.redisClient.initRemoteClient('commentFetcher', () => {
                    console.log(`Connected to remotely hosted commentFetcher redis DB for word extractor class.`);
                    if(cback) cback();
                });
            }
        });
    }

    initKeyspaceSubscriptions() {
        const self = this;
        this.redisClient.on('pmessage', function (matchedPattern, patternWithKey, action){
            if (action !== 'set') return;
            self.extractRawCommentQueue.push(patternWithKey);
            if (!self.isProcessingExtractRawCommentQueue) self.processNextQueuedNewRawCommentExtraction();
        }, 'commentFetcher');
        this.redisClient.psubscribe('__keyspace@0__:rawComment*', 'commentFetcher');
    }

    processNextQueuedNewRawCommentExtraction(curProcessingQueue) {
        // If this event was sent as part of the set pattern subcribed keyspace event, then it's "patternWithKey" will be: __keyspace@0__:comment:0b90a45d-283b-4716-aa14-ac9f99ac54b1
        const self = this;

        if (curProcessingQueue && curProcessingQueue.isCancelled) {
            // Sometimes we manually cancel an active queue via self.cancelCurrentExtractRawCommentQueue(). This may occur when  extractRawCommentQueueClearLength has been reached (see initQueueSizeCountInterval), or perhaps
            // some other health check or failsafe has deemed it necc. to make way for a fresh start on a new batch of rawComments and an existing loop must not continue, or block.
            return; // We must assume that this current processNextQueuedNewRawCommentExtraction loop has become unhealthy and out of sync with flags such as self.isProcessingExtractRawCommentQueue. We must ONLY return and not change anything else.
        }

        if (curProcessingQueue && curProcessingQueue.length === 0) {
            // looks like the queue has been finished. Reset our flag and this function will be called again later by our cback in initKeyspaceSubscriptions
            self.isProcessingExtractRawCommentQueue = false;
            return;
        }

        if (!curProcessingQueue) {
            // looks like this is the first iteration on an external call to processNextQueuedNewRawCommentExtraction (probably from initKeyspaceSubscriptions cback)
            curProcessingQueue = self.extractRawCommentQueue; // We don't shift off of the live queue because it introduces instability for a potentially orphaned loop that never ends, or sets isProcessingExtractRawCommentQueue back to false.
            self.extractRawCommentQueue = [];
            // console.warn(`Will now attempt word extraction on ${curProcessingQueue.length} new rawComments...`);
            self.isProcessingExtractRawCommentQueue = true;
            self.cancelCurrentExtractRawCommentQueue = () => {
                curProcessingQueue.isCancelled = true;
                console.warn(`An active extractRawCommentQueue was cancelled. There were ${curProcessingQueue.length} comments that were not processed.`);
            };
        }

        let rawCommentKey = curProcessingQueue.shift();
        rawCommentKey = rawCommentKey.replace('__keyspace@0__:', '');
        self.redisClient.get(rawCommentKey, (comment) => {
            if (self.commentCount[comment.source] === null) self.commentCount[comment.source] = 0;
            ++self.commentCount[comment.source]; // track our count for logging

            if (!comment || !comment.originalBody) {
                console.warn(`extractWordsFromComments could not find ${rawCommentKey} in redis, or it was missing comment.originalBody: `, comment);
                self.processNextQueuedNewRawCommentExtraction(curProcessingQueue);
                return;
            }
            self.sanitizeAndNormalizeCommentBody(comment, () => {
                self.preserveSymbolsInCommentBody(comment, () => {
                    const foundSymbolsCount = Object.keys(comment.pendingSymbols).length;
                    if (self.newCommentsMustContainSymbol && foundSymbolsCount === 0) {
                        // console.warn(`comment:${comment.id} was discarded before word extraction because it contained 0 symbols.`);
                        ++self.commentCountDiscardedNoSymbol; // track our count for logging
                        self.processNextQueuedNewRawCommentExtraction(curProcessingQueue);
                        return;
                    }
                    if (self.isDiscardComment(comment)) {
                        self.processNextQueuedNewRawCommentExtraction(curProcessingQueue);
                        return;
                    }
                    self.setStemmedCommentBody(comment, () => {
                        self.extractWordSequences(comment, () => {
                            self.setSymbolStartPoints(comment, () => {
                                commentModel.saveCommentObject(comment, self.redisClient, () => { // this must be done BEFORE saveAllWordsInComment because our other processes will be listening for word:foundAt events, then look for an associated comment:id object that hasn't yet been saved.
                                    // now proceed to save all word indexes before continuing to extraction on the next comment
                                    self.saveAllWordsInComment(comment, () => {
                                        self.processNextQueuedNewRawCommentExtraction(curProcessingQueue);
                                    });
                                });
                            }); // end setSymbolStartPoints
                        }); // end extractWordSequences
                    }); // end setStemmedCommentBody
                }); // end preserveSymbolsInCommentBody
            }); // end sanitizeAndNormalizeCommentBody
        }, 'commentFetcher'); // end self.redisClient.get
    }

    sanitizeAndNormalizeCommentBody(comment, cback) { // alters comment in-place
        const self = this;
        ///////////
        // 1. Take comment.originalBody, treat it like html, parse out text, then set the result to comment.body (overwriting whatever may have already been there)
        let sanitizedBody = '';
        let tempDomEl = null;
        try {
            tempDomEl = nodeHtmlParser(comment.originalBody);
            sanitizedBody = tempDomEl.text; //.rawText;
        } catch (e) {
            console.warn(`Could not html parse comment.originalBody in comment:${comment.id}`, comment.originalBody, e);
            return; // we can't keep this comment if it fails our parsing routine
        }
        // console.log(`Comment body: ${comment.body}`);

        ///////////////
        // 2. Now we will normalize to make different word variations as uniform as possible
        comment.normalizedBody = `${comment.body}`;

        // we only need one type of apostrophe
        // comment.body = sanitizedBody.replaceAll("’", "'");
        self.replaceInCommentBody(comment, "’", "'");

        // Normalize whitespace
        // comment.normalizedBody = comment.normalizedBody.replace(/\u{2800}+/gum, ' '); // \u{2800} is the unicode for braile 0 dot symbol (looks like a space)
        self.replaceInCommentBody(comment, /\u{2800}+/gum, ' '); // \u{2800} is the unicode for braile 0 dot symbol (looks like a space)

        // Convert wacky charachters
        // comment.normalizedBody = comment.normalizedBody.replace(/\u{2026}+/gum, '...'); // \u{2026} is the unicode for "…" charchter (a single charachter of 3 dots - elipses). This trips up urlNormalize and will now be converted into 3 "." chars.
        self.replaceInCommentBody(comment, /\u{2026}+/gum, '...'); // \u{2026} is the unicode for "…" charchter (a single charachter of 3 dots - elipses). This trips up urlNormalize and will now be converted into 3 "." chars.
        self.replaceInCommentBody(comment, '&amp;', '&'); // decode the & sign

        // Now make adjustments that will ONLY apply to comment.normalizedBody. These changes will mutate the comment body so the words can be more easily extracted. However,
        // these changes are too invasive for comment.body (which is eventually rendered in UI).

        // Twitter cuts off tweets at 140 chars when it is a retweet, then add's the "..." mid-word. If we end up with one of these, the truncated word can sometimes wronlgy match a symbol. So, we will remove the truncated word completely.
        comment.normalizedBody = comment.normalizedBody.replace(/\s[^\s]+\.\.\.$/g, ''); // https://regexr.com/6i18v

        // expand contractions BUT ONLY on comment.normalizedBody.
        let bodyTokens = naturalWordTokenizerPreserveContractions.tokenize(comment.normalizedBody);
        const normalizedBodyTokens = [];
        bodyTokens.forEach((thisToken) => {
            let thisNormalizedToken = [thisToken];
            // NOTE that naturalNormalizer will also wrongly convert plural and possesive use of "'" into an expanded contraction. Leaving as-is for now. JWW TODO
            if (Number.isNaN(parseInt(thisToken))) thisNormalizedToken = naturalNormalizer(thisToken); // don't try to expand contractions when toekn can be interpreted as a number (i.e. "it was in the 100's")
            normalizedBodyTokens.push(thisNormalizedToken.join(' '));
        });
        normalizedBodyTokens.forEach((thisNormalizedToken, index) => {
            if (bodyTokens[index] !== thisNormalizedToken) comment.normalizedBody = comment.normalizedBody.replaceAll(bodyTokens[index], thisNormalizedToken);
        });
        // console.log(`Comment normalized body: ${comment.normalizedBody}`);

        if (cback) cback();
    }

    setStemmedCommentBody(comment, cback) { // alters comment in-place
        // Now that normalizedBody has had all of it's symbols replaced with simple UID strings, but those strings have not yet been restored with the actual symbol text, we will
        // now save a stemmed representation of the entire body (had we tried to stem before injecting symbolUIDs the stemmer would malform emojis, urls, caps, etc).
        // The comment.stemmedBody is to assist with determining token sequence ordering later (looking at comment.words and determining their approx index in original comment body)
        const self = this;
        const bodyTokens = naturalWordTokenizer.tokenize(comment.normalizedBody);
        const stemmedBodyTokens = [];

        bodyTokens.forEach((thisToken) => {
            const thisStemmedToken = self.stemToken(thisToken);
            if (thisStemmedToken) stemmedBodyTokens.push(thisStemmedToken);
        });
        comment.stemmedBody = stemmedBodyTokens.join(' ');
        // console.log(`Comment stemmedBody body: ${comment.stemmedBody}`);

        if (cback) cback();
    }

    stemToken(token) {
        let stemmedToken = null;
        token = token.toLowerCase();
        if (stopWords.remove.indexOf(token) !== -1) return stemmedToken;
        stemmedToken = naturalStemmer.stem(token);
        return stemmedToken;
    }

    preserveSymbolsInCommentBody(comment, cback) {
        const self = this;
        comment.pendingSymbols = {};
        self.preserveHashtagsInCommentBody(comment, () => {
            self.preserveMentionsInCommentBody(comment, () => {
                self.preserveUrlsInCommentBody(comment, () => {
                    self.preserveEmojisInCommentBody(comment, () => {
                        self.preserveFinanceSymbolsInCommentBody(comment, 'stock', () => {
                            self.preserveFinanceSymbolsInCommentBody(comment, 'coin', () => {
                                if (cback) cback();
                            });
                        });
                    });
                });
            });
        });
    }

    preserveHashtagsInCommentBody(comment, cback) { // alters comment in-place
        const self = this;
        // This function uses regex to locate #hashtags within the comment body, then temporarily stores their markdown in comment.pendingSymbols (not saved to redis).
        // It then replaces the hashtag code strings within comment.body with a "hashtagUID" string (which natural.js will respect as a single token - already "stemmed").
        // The comment.body can then be tokenized and stemmed in extractWordSequences without malforming the hashtag code or misinterpreting it as multiple tokens.
        // After extractWordSequences has completed the word isolation logic (see "reducedTokensToStems") - the hashtags can be re-injected at their original location within
        // comment.body (by doing a string replace against the hashtagUID that was originally assigned for each hashtagss code).
        let commentBody = `${comment.normalizedBody}`; // We will preserve untouched body text for rendering, and format a temporary local copy for this function's hashtag extraction logic
        const foundHashtags = {}; // {'#yolo': PendingSymbolEntity, etc...}

        const hashtagMatches = Array.from(commentBody.matchAll(/#[^\s!@#$%^&*()=+\-./,[{\]};:'"?><]+/gm)); // All chars except whitespace, punctuation, and reserved code chars. https://regexr.com/6hq7m
        hashtagMatches.forEach((thisHashtagMatch) => {
            const thisHashtag = thisHashtagMatch[0];

            // hashHype rule - a hashtag cannot be a number
            const thisHashTagNoHash = thisHashtag.slice(1);
            if (`${parseInt(thisHashTagNoHash.slice(1))}` === thisHashTagNoHash) return;

            if (!foundHashtags[thisHashtag]) {
                const hashtagAssocs = [];
                if (comment.wordAssocs && comment.wordAssocs[thisHashtag]) {
                    hashtagAssocs.push(comment.wordAssocs[thisHashtag]);
                }
                foundHashtags[thisHashtag] = self.newPendingSymbolEntity({
                    token: thisHashtag,
                    type: 'hashtag',
                    normalizedToken: thisHashtag,
                    symbolKey: `symbol:hashtag:${thisHashtag}`,
                    assocs: hashtagAssocs
                });
            }
        });

        // const hashtagKeys = Object.keys(foundHashtags);
        // if (hashtagKeys.length) console.log(`Found ${hashtagKeys.length} hashtags in comment:${comment.id}`, hashtagKeys);

        const symbolSearchPromises = [];
        Object.values(foundHashtags).forEach((thisPendingSymbolEntity) => {
            symbolSearchPromises.push(new Promise( (resolve, reject) => {
                // See if this hashtag symbol already exists in redis. If not, create now.
                self.redisClient.get(thisPendingSymbolEntity.symbolKey, (symbol, actualAbsKey) => { // actualAbsKey will be defined when this .get followed an alias. Needed below.
                    if(symbol) {
                        // now that we have done a very basic symbol match against our redis key pattern, we will confirm the match by passing this token
                        // into the symbols customizable match function.

                        // In case this symbolKey actually pointed to a keyAlias, and the parent object was returned as symbol, correct the symbolKey now.
                        if (actualAbsKey) thisPendingSymbolEntity.symbolKey = actualAbsKey;

                        const isMatch = symbolModel.execMatch(symbol, thisPendingSymbolEntity.token, comment);
                        if(!isMatch) {
                            resolve(thisPendingSymbolEntity);
                            return;
                        }
                        // console.log(`comment:${comment.id} contained word ${thisToken} which matched an existing symbol ${symbolKey}`);
                        thisPendingSymbolEntity.matchedSymbol = symbol;
                        resolve(thisPendingSymbolEntity);
                    } else {
                        // redis Symbol object for this hashtag does not yet exist, create and save it now.
                        const newSymbolObj = symbolModel.createSymbolObject({
                            name: thisPendingSymbolEntity.normalizedToken,
                            symbol: thisPendingSymbolEntity.token,
                            type: 'hashtag',
                            assocs: thisPendingSymbolEntity.assocs,
                        });
                        self.redisClient.set(thisPendingSymbolEntity.symbolKey, symbolModel.minimizeForDb(newSymbolObj), () => {
                            // console.log(`Created new hashtag symbol object for ${thisPendingSymbolEntity.symbolKey}`);
                            thisPendingSymbolEntity.matchedSymbol = newSymbolObj;
                            resolve(thisPendingSymbolEntity);
                        });
                    }
                });
            }));
        });

        Promise.all(symbolSearchPromises).then((pendingSymbolEntities) => {
            let idIncrement = 0;
            pendingSymbolEntities.forEach((thisPendingSymbolEntity) => {
                if (thisPendingSymbolEntity.matchedSymbol) {
                    const thisHashtagUid = `hh__hashtag${++idIncrement}symbol__hh`;
                    const thisHashtagCodeEscapedForRegex = thisPendingSymbolEntity.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // the string we are matching against needs to be escaped for regex. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
                    const hashtagReplaceRegex = new RegExp(thisHashtagCodeEscapedForRegex, 'gm');
                    self.replaceInCommentBody(comment, hashtagReplaceRegex, ` ${thisHashtagUid} `); // We pad with spaces to make sure natural.js treats this as an isolated token. i.e. non-spaced hashtags like "Hey i like hashtags!hashtag1symbolhashtag2symbolhashtag1symbol" would come out as 1 token
                    comment.pendingSymbols[thisHashtagUid] = thisPendingSymbolEntity;
                }
            });
            if (cback) cback();
        });
    } // end preserveHashtagsInCommentBody

    preserveMentionsInCommentBody(comment, cback) { // alters comment in-place
        const self = this;
        // This function uses regex to locate @mentions within the comment body, then temporarily stores their markdown in comment.pendingSymbols (not saved to redis).
        // It then replaces the mention code strings within comment.body with a "mentionUID" string (which natural.js will respect as a single token - already "stemmed").
        // The comment.body can then be tokenized and stemmed in extractWordSequences without malforming the mention code or misinterpreting it as multiple tokens.
        // After extractWordSequences has completed the word isolation logic (see "reducedTokensToStems") - the mentions can be re-injected at their original location within
        // comment.body (by doing a string replace against the mentionUID that was originally assigned for each mentions code).
        let commentBody = `${comment.normalizedBody}`; // We will preserve untouched body text for rendering, and format a temporary local copy for this function's mention extraction logic
        const foundMentions = {}; // {'@yolo': PendingSymbolEntity, etc...}

        const mentionMatches = Array.from(commentBody.matchAll(/@[^\s!@#$%^&*()=+\-./,[{\]};:'"?><]+/gm)); // All chars except whitespace, punctuation, and reserved code chars. https://regexr.com/6hq7m
        mentionMatches.forEach((thisMentionMatch) => {
            const thisMention = thisMentionMatch[0];
            if (!foundMentions[thisMention]) {
                const mentionAssocs = [];
                if (comment.wordAssocs && comment.wordAssocs[thisMention]) {
                    mentionAssocs.push(comment.wordAssocs[thisMention]);
                }
                foundMentions[thisMention] = self.newPendingSymbolEntity({
                    token: thisMention,
                    type: 'mention',
                    normalizedToken: thisMention,
                    symbolKey: `symbol:mention:${thisMention}`,
                    assocs: mentionAssocs
                });
            }
        });

        // const mentionKeys = Object.keys(foundMentions);
        // if (mentionKeys.length) console.log(`Found ${mentionKeys.length} mentions in comment:${comment.id}`, mentionKeys);

        const symbolSearchPromises = [];
        Object.values(foundMentions).forEach((thisPendingSymbolEntity) => {
            symbolSearchPromises.push(new Promise( (resolve, reject) => {
                // See if this mention symbol already exists in redis. If not, create now.
                self.redisClient.get(thisPendingSymbolEntity.symbolKey, (symbol, actualAbsKey) => { // actualAbsKey will be defined when this .get followed an alias. Needed below.
                    if(symbol) {
                        // now that we have done a very basic symbol match against our redis key pattern, we will confirm the match by passing this token
                        // into the symbols customizable match function.

                        // In case this symbolKey actually pointed to a keyAlias, and the parent object was returned as symbol, correct the symbolKey now.
                        if (actualAbsKey) thisPendingSymbolEntity.symbolKey = actualAbsKey;

                        const isMatch = symbolModel.execMatch(symbol, thisPendingSymbolEntity.token, comment);
                        if(!isMatch) {
                            resolve(thisPendingSymbolEntity);
                            return;
                        }
                        // console.log(`comment:${comment.id} contained word ${thisToken} which matched an existing symbol ${symbolKey}`);
                        thisPendingSymbolEntity.matchedSymbol = symbol;
                        resolve(thisPendingSymbolEntity);
                    } else {
                        // redis Symbol object for this mention does not yet exist, create and save it now.
                        const newSymbolObj = symbolModel.createSymbolObject({
                            name: thisPendingSymbolEntity.normalizedToken,
                            symbol: thisPendingSymbolEntity.token,
                            type: 'mention',
                            assocs: thisPendingSymbolEntity.assocs,
                        });
                        self.redisClient.set(thisPendingSymbolEntity.symbolKey, symbolModel.minimizeForDb(newSymbolObj), () => {
                            // console.log(`Created new mention symbol object for ${thisPendingSymbolEntity.symbolKey}`);
                            thisPendingSymbolEntity.matchedSymbol = newSymbolObj;
                            resolve(thisPendingSymbolEntity);
                        });
                    }
                });
            }));
        });

        Promise.all(symbolSearchPromises).then((pendingSymbolEntities) => {
            let idIncrement = 0;
            pendingSymbolEntities.forEach((thisPendingSymbolEntity) => {
                if (thisPendingSymbolEntity.matchedSymbol) {
                    const thisMentionUid = `hh__mention${++idIncrement}symbol__hh`;
                    const thisMentionCodeEscapedForRegex = thisPendingSymbolEntity.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // the string we are matching against needs to be escaped for regex. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
                    const mentionReplaceRegex = new RegExp(thisMentionCodeEscapedForRegex, 'gm');
                    self.replaceInCommentBody(comment, mentionReplaceRegex, ` ${thisMentionUid} `); // We pad with spaces to make sure natural.js treats this as an isolated token. i.e. non-spaced mentions like "Hey i like mentions!mention1symbolmention2symbolmention1symbol" would come out as 1 token
                    comment.pendingSymbols[thisMentionUid] = thisPendingSymbolEntity;
                }
            });
            if (cback) cback();
        });
    } // end preserveMentionsInCommentBody

    preserveUrlsInCommentBody(comment, cback) { // alters comment in-place
        const self = this;
        const escapeUrlForRegex = (url) => {
            return url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Use this function when we are injecting a url string into a regex. Certain charachters within a URL need to be escaped for regex. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
        }

        // This function uses regex to locate urls within the comment body, then temporarily stores those URLs in comment.pendingSymbols (not saved to redis).
        // It then replaces the URL strings within comment.body with a "urlUid" string (which natural.js will respect as a single token - already "stemmed").
        // The comment.body can then be tokenized and stemmed in extractWordSequences without malforming the URL or misinterpreting it as multiple tokens.
        // After extractWordSequences has completed the word isolation logic (see "reducedTokensToStems") - the URLs can be re-injected at their original location within
        // comment.body (by doing a string replace against the urlUid that was originally assigned for each URL). urlUid in format `comment${number}` will not be altered by natural js (porter stemmer).
        let commentBody = `${comment.normalizedBody}`; // We will preserve untouched body text for rendering, and format a temporary local copy for this function's URL extraction logic
        const foundUrlsFirstPass = commentBody.match(urlRegex({strict: false}));
        if (!foundUrlsFirstPass) {
            if (cback) cback();
            return;
        }

        // 1. Perform some alterations to the commentBody that will better support our regex based URL extraction below.

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
                // found a trailing parenth/bracket. Take it off now BUT only if we can confirm this is actually a closing parenthesis (not actually part of the URL as they are technically valid url chars)
                const testIsClosingParenth = new RegExp(`\\([^)]*${escapeUrlForRegex(thisSecondPassUrl)}`, 'gm');
                const isClosingParenth = testIsClosingParenth.test(commentBody);
                if (isClosingParenth) {
                    const thisSecondPassUrlNoClosing = thisSecondPassUrl.slice(0, thisSecondPassUrl.indexOf(')'));
                    // console.warn(`Removed closing parenthesis from url ${thisSecondPassUrl} -> ${thisSecondPassUrlNoClosing}`);
                    commentBody = commentBody.replace(thisSecondPassUrl, thisSecondPassUrlNoClosing);
                }
            }
        });

        // 2. Now we are ready to make a final pass at foundUrls and then replace all found URLs with our urlUid placeholders
        const foundUrls = commentBody.match(urlRegex({strict: false}));
        if (!foundUrls) {
            if (cback) cback();
            return;
        }

        // console.log(`Found ${foundUrls.length} urls in comment:${comment.id}`);
        const urlSymbolSearchPromises = [];
        foundUrls.forEach((thisUrl) => {
            urlSymbolSearchPromises.push(new Promise( (resolve, reject) => {
                const tokenSymbolResult = self.newPendingSymbolEntity({token: thisUrl, type: 'url'});
                let normalizedUrl;
                try {
                    normalizedUrl = urlNormalize(thisUrl);
                } catch (e) {
                    console.warn(`Could not normalize URL in comment:${comment.id}`, e);
                    resolve(tokenSymbolResult);
                    return;
                }
                tokenSymbolResult.normalizedToken = normalizedUrl;

                // Generate a symbol key from this URL and see if it already exists in redis. If not, create now.
                const symbolKey = `symbol:url:${normalizedUrl}`;
                tokenSymbolResult.symbolKey = symbolKey;
                self.redisClient.get(symbolKey, (symbol, actualAbsKey) => { // actualAbsKey will be defined when this .get followed an alias. Needed below.
                    if(symbol) {
                        // now that we have done a very basic symbol match against our redis key pattern, we will confirm the match by passing this token
                        // into the symbols customizable match function.

                        // In case this symbolKey actually pointed to a keyAlias, and the parent object was returned as symbol, correct the symbolKey now.
                        if (actualAbsKey) tokenSymbolResult.symbolKey = actualAbsKey;

                        const isMatch = symbolModel.execMatch(symbol, thisUrl, comment);
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
                            type: 'url',
                            assocs: tokenSymbolResult.assocs,
                        });
                        self.redisClient.set(symbolKey, symbolModel.minimizeForDb(newSymbolObj), () => {
                            // console.log(`Created new URL symbol object for ${symbolKey}`);
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
                    const thisUrlUid = `hh__url${++idIncrement}__hh`;
                    const thisUrlEscapedForRegex = escapeUrlForRegex(tokenSymbolResult.token); // the string we are matching against needs to be escaped for regex. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
                    const newUrlRegex = new RegExp(thisUrlEscapedForRegex, 'gm'); // remember has to be double escaped cuz it's wrapped in string concat. https://regexr.com/5q5m8
                    self.replaceInCommentBody(comment, newUrlRegex, thisUrlUid);
                    if (!comment.pendingSymbols) {
                        console.error('No comment.pendingSymbols? Please inspect:', thisUrlUid, tokenSymbolResult, comment);
                        return;
                    }
                    comment.pendingSymbols[thisUrlUid] = tokenSymbolResult;
                }
            });
            if (cback) cback();
        });
    }

    preserveFinanceSymbolsInCommentBody(comment, symbolType = 'stock', cback) { // type can be 'stock' or 'coin'
        const self = this;
        // Like "preserveUrlsInCommentBody", this command extracts potential stock symbol matches BEFORE the comment body is stemmed/tokenized in "extractWordSequences".
        // This is to preserve symbols like "MVIS" - which would get tokenized to MVI.
        const commentTokens = naturalWordTokenizer.tokenize(comment.normalizedBody);

        const tokenSymbolSearchPromises = [];
        commentTokens.forEach((thisToken, thisTokenIndex) => {
            tokenSymbolSearchPromises.push(new Promise( (resolve, reject) => {
                const symbolKey = `symbol:${symbolType}:${thisToken}`; // `symbol:stock:GME` - stock symbol object keys always make the ticker caps
                const tokenSymbolResult = self.newPendingSymbolEntity({token: thisToken, normalizedToken: thisToken, symbolKey: symbolKey});

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
                self.redisClient.get(symbolKey, (symbol, actualAbsKey) => { // actualAbsKey will be defined when this .get followed an alias. Needed below.
                    if(!symbol) {
                        resolve(tokenSymbolResult);
                        return;
                    }

                    // In case this symbolKey actually pointed to a keyAlias, and the parent object was returned as symbol, correct the symbolKey now.
                    if (actualAbsKey) tokenSymbolResult.symbolKey = actualAbsKey;

                    let isMatch = symbolModel.execMatch(symbol, thisToken, comment);
                    if(!isMatch) { // We manually support passing $ to the custom match function if a "$" token preceeded this stock symbol. Some custom match functions will require $ to be preset (when tokens withou $ are too too ambiguous)
                        // dollar signs are stripped from tokenized body, so we manually add it now (IF we find that it was present in normalizedBody)
                        if (new RegExp(`\\s\\$${thisToken}\\s`, 'gm').test(comment.normalizedBody)) { // https://regexr.com/6houn
                            isMatch = symbolModel.execMatch(symbol, `$${thisToken}`, comment);
                        }
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
                    const thisStockUid = `hh__${symbolType}${++idIncrement}__hh`;
                    const stockSymbolRegex = new RegExp(`\\b${tokenSymbolResult.token}\\b`, 'gim'); // https://regexr.com/5rrbf
                    //comment.body = comment.body.replace(stockSymbolRegex, thisStockUid);
                    self.replaceInCommentBody(comment, stockSymbolRegex, thisStockUid);
                    comment.pendingSymbols[thisStockUid] = tokenSymbolResult;
                }
            });
            if (cback) cback();
        });

    } // end preserveFinanceSymbolsInCommentBody

    preserveEmojisInCommentBody(comment, cback) { // alters comment in-place
        const self = this;
        // This function uses regex to locate emoji/emotes within the comment body, then temporarily stores their markdown in comment.pendingSymbols (not saved to redis).
        // It then replaces the emoji code strings within comment.body with a "emojiUID" string (which natural.js will respect as a single token - already "stemmed").
        // The comment.body can then be tokenized and stemmed in extractWordSequences without malforming the emoji code or misinterpreting it as multiple tokens.
        // After extractWordSequences has completed the word isolation logic (see "reducedTokensToStems") - the emojis can be re-injected at their original location within
        // comment.body (by doing a string replace against the emojiUID that was originally assigned for each emoji code).
        let commentBody = `${comment.normalizedBody}`; // We will preserve untouched body text for rendering, and format a temporary local copy for this function's emoji extraction logic
        const foundEmojis = {}; // {':happy_face:': PendingSymbolEntity, etc...}

        // 1. Look for the shortcode format :emoji-happy: :emoji_happy: :emojihappy: format. See https://www.webfx.com/tools/emoji-cheat-sheet/
        // const foundColonEmojis = Array.from(commentBody.matchAll(/(^|\s)(:[a-zA-Z0-9_-]+:)/gm)); // https://regexr.com/69405
        const foundColonEmojis = Array.from(commentBody.matchAll(emojiShortcodeRegex.source, 'g'));
        foundColonEmojis.forEach((thisEmojiMatch) => {
            const thisEmojiCode = thisEmojiMatch[0];
            if (!foundEmojis[thisEmojiCode]) {
                const emojiAssocs = [];
                if (comment.wordAssocs && comment.wordAssocs[thisEmojiCode]) {
                    emojiAssocs.push(comment.wordAssocs[thisEmojiCode]);
                }
                foundEmojis[thisEmojiCode] = self.newPendingSymbolEntity({
                    token: thisEmojiCode,
                    type: 'emoji',
                    normalizedToken: thisEmojiCode,
                    symbolKey: `symbol:emoji:${thisEmojiCode}`, // Note that our redis namespace delimeter is also a ":". We are creating the redis key symbol:emoji::happy_face: - this will not be a problem, but something to be aware of.
                    assocs: emojiAssocs
                });
            }
        });

        // 2. Look for unicode emojis and convert them to :shortcode:. HashHype keeps all emojis within text in the shortcode format and can convert them at render time on client.
        // const foundUnicodeEmojis = Array.from(commentBody.matchAll(emojiRegex()));
        const foundUnicodeEmojis = Array.from(commentBody.matchAll(emojiUnicodeRegex.source, 'g'));
        foundUnicodeEmojis.forEach((thisEmojiMatch) => {
            const emojiChar = thisEmojiMatch[0];
            const emojiUniCode = emojiChar.codePointAt(0).toString(16); // If this is "grinning face" (U+1F600) emojiCode is "1f600" https://gotomorrow.dev/convert-emoji-character-to-unicode-number-in-javascript
            const thisEmojiCode = `:u_${emojiUniCode}:` // When hashHype converts unicode to shortcode, U+1F600 becomes ":u_1f600:"
            foundEmojis[thisEmojiCode] = self.newPendingSymbolEntity({
                token: thisEmojiCode,
                type: 'emoji',
                normalizedToken: thisEmojiCode,
                symbolKey: `symbol:emoji:${thisEmojiCode}`, // Note that our redis namespace delimeter is also a ":". We are creating the redis key symbol:emoji::happy_face: - this will not be a problem, but something to be aware of.
                assocs: [{assoc: emojiChar, type: 'unicode'}]
            });
            // In the case of unicode emojis, we also alter the comment body to show our custom shortcode format instead
            // comment.body = comment.body.replaceAll(emojiChar, thisEmojiCode);
            self.replaceInCommentBody(comment, emojiChar, thisEmojiCode);
        });

        // const emojiKeys = Object.keys(foundEmojis);
        // if (emojiKeys.length) console.log(`Found ${emojiKeys.length} emojis in comment:${comment.id}`, emojiKeys);

        const symbolSearchPromises = [];
        Object.values(foundEmojis).forEach((thisPendingSymbolEntity) => {
            symbolSearchPromises.push(new Promise( (resolve, reject) => {
                // See if this emoji symbol already exists in redis. If not, create now.
                self.redisClient.get(thisPendingSymbolEntity.symbolKey, (symbol, actualAbsKey) => { // actualAbsKey will be defined when this .get followed an alias. Needed below.
                    if(symbol) {
                        // now that we have done a very basic symbol match against our redis key pattern, we will confirm the match by passing this token
                        // into the symbols customizable match function.

                        // In case this symbolKey actually pointed to a keyAlias, and the parent object was returned as symbol, correct the symbolKey now.
                        if (actualAbsKey) thisPendingSymbolEntity.symbolKey = actualAbsKey;

                        const isMatch = symbolModel.execMatch(symbol, thisPendingSymbolEntity.token, comment);
                        if(!isMatch) {
                            resolve(thisPendingSymbolEntity);
                            return;
                        }
                        // console.log(`comment:${comment.id} contained word ${thisToken} which matched an existing symbol ${symbolKey}`);
                        thisPendingSymbolEntity.matchedSymbol = symbol;
                        resolve(thisPendingSymbolEntity);
                    } else {
                        // redis Symbol object for this emoji does not yet exist, create and save it now.
                        const newSymbolObj = symbolModel.createSymbolObject({
                            name: thisPendingSymbolEntity.normalizedToken,
                            symbol: thisPendingSymbolEntity.token,
                            type: 'emoji',
                            assocs: thisPendingSymbolEntity.assocs,
                        });
                        self.redisClient.set(thisPendingSymbolEntity.symbolKey, symbolModel.minimizeForDb(newSymbolObj), () => {
                            console.log(`Created new emoji symbol object for ${thisPendingSymbolEntity.symbolKey}`);
                            thisPendingSymbolEntity.matchedSymbol = newSymbolObj;
                            resolve(thisPendingSymbolEntity);
                        });
                    }
                });
            }));
        });

        Promise.all(symbolSearchPromises).then((pendingSymbolEntities) => {
            let idIncrement = 0;
            pendingSymbolEntities.forEach((thisPendingSymbolEntity) => {
                if (thisPendingSymbolEntity.matchedSymbol) {
                    const thisEmojiUid = `hh__emoji${++idIncrement}symbol__hh`;
                    const thisEmojiCodeEscapedForRegex = thisPendingSymbolEntity.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // the string we are matching against needs to be escaped for regex. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#escaping
                    const emojiReplaceRegex = new RegExp(thisEmojiCodeEscapedForRegex, 'gm');
                    self.replaceInCommentBody(comment, emojiReplaceRegex, ` ${thisEmojiUid} `); // We pad with spaces to make sure natural.js treats this as an isolated token. i.e. non-spaced emojis like "Hey i like emojis!emoji1symbolemoji2symbolemoji1symbol" would come out as 1 token
                    //comment.body = comment.body.replace(emojiReplaceRegex, `${thisEmojiUid} `); // We add a trailing space to make sure natural.js treats this as an isolated token. i.e. non-spaced emojis like "Hey i like emojis! emoji1symbolemoji2symbolemoji1symbol" would come out as 1 token
                    comment.pendingSymbols[thisEmojiUid] = thisPendingSymbolEntity;
                }
            });
            if (cback) cback();
        });
    } // end preserveEmojisInCommentBody

    extractWordSequences(commentData, cback) {
        const self = this;
        /////////////////
        // Form the following object from the comment body: 'Jim Cramer puts milk first in his bowls'
        // const tokensToStems = [
        //     {
        //         tokenized: ['Jim', 'Cramer'], // tokenized bigram
        //         stemmed: ['jim', 'cramer'] // same bigram after stemmed too
        //     },
        //     { // we currently only save singleWordSymbols/bigrams/trigrams to redis, but since a tokenized sequence is often shortened after stemming, our token sequences will include all the way up to 6 tokens.
        //         tokenized: ['First', 'in', 'his', 'bowls', "isn't"], // contractions are preserved so they can be searched for against comment body later (like in UI point illustration rendering)
        //         stemmed: ['first', 'bowl', 'not'] // contractions are normalized during stemming
        //     },
        //     {
        //         tokenized: ['a', 'first', 'in', 'bowling'],
        //         stemmed: ['first', 'bowl']
        //     },
        //     // etc...
        // ];
        // We use this method because we want to save the raw word sequence that resulted in a new redis word object (word:symbol, word:bigram, word:trigram) for comparison later.
        // To use the example above, the 2nd entry would result in a new redis object with key "word:bigram:first_bowl" but the full raw word sequence is what would be used to match against symbols (using custom match functions).
        const maxNgram = 3; // We only save word sequences to redis up to 3 words max (stemmed)
        const tokensToStems = [];
        [1,2,3,4,5,6].forEach((thisN) => {
            const theseTokenSets = naturalNGrams.ngrams(commentData.body, thisN); // naturalNGrams.ngrams has tokenized BUILT IN and preserves contractions. We run nGrams against commentData.body because contractions have already been expanded in comment.normalizedBody
            theseTokenSets.forEach((thisTokenSet) => {
                const tokensStemmed = [];
                thisTokenSet.forEach((thisToken) => {
                    let thisNormalizedToken = [thisToken]; // naturalNormalizer returns an array.
                    if (Number.isNaN(parseInt(thisToken))) { // don't try to expand contractions when toekn can be interpreted as a number (i.e. "it was in the 100's")
                        thisNormalizedToken = naturalNormalizer(thisToken);  // naturalNormalizer returns an array. JWW stopping - this doesn't work on "y'all" - see https://github.com/NaturalNode/natural/issues/635
                    }

                    thisNormalizedToken.forEach((thisNormalizedTokenPart) => {
                        const thisStemmedToken = self.stemToken(thisNormalizedTokenPart);
                        if (thisStemmedToken) tokensStemmed.push(thisStemmedToken);
                    });
                });

                if (!tokensStemmed.length) return;
                tokensToStems.push({
                    tokenized: thisTokenSet,
                    stemmed: tokensStemmed,
                });
            })
        });
        // if (commentData.body.indexOf("'") !== -1) console.log(commentData.body,  util.inspect(tokensToStems, {depth: 5, colors: true}))

        // Now transform the above object into the following:
        // {
        //     'first_bowl': ['First in his bowl', "First is the bowl and isn't", 'A First is in bowling', ..etc],
        //     etc...
        // }
        // This reduces down all the token sequences into uniform stem keys (these stem keys (sequenceKey) are used when setting/getting word: objects to redis)
        const reducedTokensToStems = {};
        tokensToStems.forEach((thisTokenToStem) => {
            if (thisTokenToStem.stemmed.length > maxNgram) return; // The outcome from this stemming resulted in too long a sequence. Discard.
            const sequenceKey = thisTokenToStem.stemmed.join('_!!_'); // _!!_ is the hashHype word delimeter

            // Be careful because we are now assigning dynamic, user provided naming to the reducedTokensToStems object.
            if (reducedTokensToStems.__proto__[sequenceKey] || (reducedTokensToStems[sequenceKey] && !Array.isArray(reducedTokensToStems[sequenceKey])) ){
                console.warn(`Will not process extracted word "${sequenceKey}" on comment:${commentData.id} because it is the name of a prototype value. Potential security flag. Comment body:`, commentData.body);
                return;
            }

            if (!reducedTokensToStems[sequenceKey]) reducedTokensToStems[sequenceKey] = [];
            reducedTokensToStems[sequenceKey].push(thisTokenToStem.tokenized.join(' '));
        });
        // if (commentData.normalizedBody.indexOf("'") !== -1) console.log(commentData.body,  util.inspect(reducedTokensToStems, {depth: 5, colors: true}))


        ///////////////
        // Now that we reduced comment body to token sequences, loop through and restore symbols (from symbolUIDs), pass through isDiscardWord, and save all to redis as new words objects with accompanying wordToComments and foundAt indexes
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
                    self.replaceInCommentBody(commentData, symbolUidRegex, tokenSymbolResult.normalizedToken);
                    //commentData.body = commentData.body.replace(symbolUidRegex, tokenSymbolResult.normalizedToken);
                    //commentData.stemmedBody = commentData.stemmedBody.replace(symbolUidRegex, tokenSymbolResult.normalizedToken);
                    sequenceKey = sequenceKey.replace(symbolUidRegex, tokenSymbolResult.normalizedToken);
                    allRawTokenSequences.forEach((thisRawSeq, thisRawSeqIndex) => {
                        allRawTokenSequences[thisRawSeqIndex] = thisRawSeq.replace(symbolUidRegex, tokenSymbolResult.normalizedToken);
                    });
                });
            }

            // Split the token sequence into an array of tokens so we can assign to wordObj.value, and determine the wordObj.type
            stemSequence = sequenceKey.split('_!!_'); // reset this because sequenceKey may have changed while replacing symbolUidsInStemSequence
            let wordType = 'word';
            if (stemSequence.length === 2) wordType = 'bigram';
            if (stemSequence.length === 3) wordType = 'trigram';
            if (stemSequence.length > 3) continue;

            // Check if this word should be discard from relevancy training or by other rules.
            if ( self.isDiscardWord(sequenceKey, wordType, symbolsInWord, stemSequence) ) continue;

            // Determine the index(es) of this word within comment.stemmedBody. This is saved in our wordRef object, attached to the comment. Used in forming 2dGrams later.
            let indexesOfWordInStemmedBody = [];
            let searchForWordStr = stemSequence.join(' ');
            let searchWordRegExp = null;
            try {
                searchWordRegExp = new RegExp(searchForWordStr,'g')
            } catch (e) {
                console.error(`Could not create a RegExp to search for word "${searchForWordStr}" within comment:${commentData.id}`, commentData.body, e);
                continue;
            }
            const matches = commentData.stemmedBody.matchAll(searchWordRegExp);
            for (const match of matches) indexesOfWordInStemmedBody.push(match.index);

            // ALSO determine the index(es) of each raw word seq associated with this word within comment.body. These indexes are used to search for a word within comment.body later (like when applying point viz to readable comment body in UI)
            let indexesOfWordInRawBody = [];
            allRawTokenSequences.forEach((thisRawTokensSeq) => {
                let searchRawWordRegExp = null;
                try {
                    searchRawWordRegExp = new RegExp(thisRawTokensSeq,'g')
                } catch (e) {
                    console.error(`Could not create a RegExp to search for raw word "${thisRawTokensSeq}" within comment:${commentData.id}`, commentData.body, e);
                    return;
                }
                const matches = commentData.body.matchAll(searchRawWordRegExp);
                for (const match of matches) indexesOfWordInRawBody.push(match.index);
            });
            indexesOfWordInRawBody = [...new Set(indexesOfWordInRawBody)]; // remove dups

            const wordRef = wordModel.createWordRefObject({ // Store a wordRef object on the comment
                word: sequenceKey,
                rawWords: allRawTokenSequences,
                type: wordType,
                hasSymbols: symbolsInWord,
                index: indexesOfWordInStemmedBody,
                rawIndex: indexesOfWordInRawBody
            });
            commentData.words[sequenceKey] = wordRef;

            // If this single word matched a symbol alias, it will have a hasSymbols entry that points to a symbolStr which is not equal to own sequenceKey. We must also store a wordRef on the comment for the actual symbol (or it will not fire foundAt tstamps, or be pointed on word)
            if (wordType === 'word' && symbolsInWord && symbolsInWord.length) {
                symbolsInWord.forEach((thisSymbolKey) => {
                    const thisSymbolWordStr = thisSymbolKey.split(':').splice(2).join(':');
                    if (thisSymbolWordStr === sequenceKey) return;
                    const aliasSymbolWordRef = {...wordRef};
                    wordRef.isSymbolAlias = true;
                    if (commentData.words[thisSymbolWordStr]) return;
                    aliasSymbolWordRef.word = thisSymbolWordStr;
                    commentData.words[thisSymbolWordStr] = aliasSymbolWordRef;
                });
            }

        } // end for reducedTokensToStems loop

        if(cback) cback();
    } //end extractWordSequences

    setSymbolStartPoints(comment, cback) {
        const self = this;
        // This function points ONLY symbols within this comment right when the comment is created. These points are assigned to comment.symbolStartPoints. They are the points in the 1Hr prior to comment creation.
        // Essentially, these points represent the context in which this comment was originally made.  It gives topCommentStats an idea for how to sort/rank a coment, and which symbol group(s) it should belong to.
        // These points are only calculated once (during a comment's initial word extraction), and because they don't change, they can be a useful record for seeing how each symbol grew during a comments duration.
        const msIn1Hr = 3600000;
        const checkedSymbols = []; // a record of which symbols have already been counted so we don't sum the same symbol foundAts more than once.
        const symbolStartPoints = {}; // {'symbol:coin:HNT': 234, 'symbol:stock:GME': 9123, etc...}
        const symbolsFoundAtCountPromises = [];
        for (let [wordStr, thisWordRef] of Object.entries(comment.words)) {
            thisWordRef.hasSymbols.forEach((thisSymbolKey) => {
                if (checkedSymbols.indexOf(thisSymbolKey) !== -1) return;
                checkedSymbols.push(thisSymbolKey);

                const thisSymbolWordStr = thisSymbolKey.split(':').slice(2).join(':');
                const foundAtListKey = `word:${thisSymbolWordStr}:foundAt`;
                symbolsFoundAtCountPromises.push(new Promise( (resolve, reject) => {
                    const now = Date.now();
                    self.redisClient.zrange(foundAtListKey, now - msIn1Hr, now, (allFoundAtTstamps) => {
                        if (!allFoundAtTstamps || !allFoundAtTstamps.length) {
                            symbolStartPoints[thisSymbolKey] = 0;
                            resolve();
                            return;
                        }
                        const wordPointVal = wordModel.getWordPointCount(thisWordRef, comment);
                        symbolStartPoints[thisSymbolKey] = allFoundAtTstamps.length * wordPointVal;
                        resolve();
                    }); // end self.redisClient.lrange
                })); // end symbolsFoundAtCountPromises.push
            }); // end thisWordRef.hasSymbols.forEach
        }; // end for (let [wordStr, thisWordRef] of Object.entries(comment.words)

        Promise.all(symbolsFoundAtCountPromises).then(() => {
            comment.symbolStartPoints = symbolStartPoints;
            if (cback) cback();
        });
    }

    saveAllWordsInComment(comment, cback) {
        const self = this;
        const wordSavePromises = [];
        for (let [thisWordStr, thisWordRef] of Object.entries(comment.words)) {
            if (thisWordRef.isSymbolAlias) continue; // We never fire foundAts for words that matched a symbolAlias. There will be another wordRef on this comment that has the actual symbol.symbol assigned to wordRef.word. That's the one that will register foundAts.
            wordSavePromises.push(new Promise( (resolve, reject) => {
                // Add a foundAt tstamp for this word and save this comment to it's WordToCommentsIndex (creating one if it does not yet exist)
                wordModel.addFoundAtTstampForWord(thisWordStr, comment, self.redisClient, () => { // this must be done BEFORE registerWordToCommentsIndex or the foundAt tstamp will be cancelled as dup word by same user.
                    wordModel.registerWordToCommentsIndex(thisWordStr, comment, self.redisClient, () => {
                        resolve();
                    });
                });
            })); // end wordSavePromises.push
        };
        Promise.all(wordSavePromises).then(() => {
            if (cback) cback();
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

    isDiscardWord(wordString, wordType, symbolsInWord = [], stemSequence = []) {
        // this process includes rules around which comments should be included in trend analysis. Ie: comments that are too long... comments that look like bots or spam, etc.
        let shouldDiscard = false;

        // If is a single word that includes no symbols
        if (wordType === 'word' && symbolsInWord.length === 0) {
            shouldDiscard = true;
            return shouldDiscard;
        }

        if (wordType === 'bigram') {
            // If is a bigram and both tokens are the same
            if (stemSequence[0] === stemSequence[1]) {
                shouldDiscard = true;
                return shouldDiscard;
            }
        }

        if (wordType === 'trigram') {
            // If is a trigram and two tokens in a row are the same
            if (stemSequence[0] === stemSequence[1] || stemSequence[1] === stemSequence[2]) {
                shouldDiscard = true;
                return shouldDiscard;
            }
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

    isDiscardComment(comment) {
        // this process includes rules around which comments should be included in trend analysis. Ie: comments that are too long... comments that look like bots or spam, etc.
        // during this check, 'COMMENT IN CAPS HTTPS://TWITTER.COM/sdfWE8' is now 'COMMENT IN CAPS hh__url1symbol__hh'
        // We can now temporarily remove all symbol placeholders, look at the remaining text, and run discard logic against it in isolation.
        let shouldDiscard = false;
        const commentBodySansSymbols = comment.normalizedBody.replaceAll(/hh__[^__hh]+__hh/gm, ''); // https://regexr.com/6hrm6

        // 1. HashHype rule - no all-caps. We run the all caps discard check in our fetchComment processes too. However, we check again here after we have normalized and converted symbols into temporory ID placeholders.
        // I.e: during this check, 'COMMENT IN CAPS HTTPS://TWITTER.COM/sdfWE8' is now 'COMMENT IN CAPS hh__url1symbol__hh'
        // We can now temporarily remove all symbol placeholders, look at the remaining text, and run discard logic against it in isolation.
        const allCapsBody = commentBodySansSymbols.toUpperCase();
        if (allCapsBody === commentBodySansSymbols) {
            shouldDiscard = true;
            // console.warn(`comment:${comment.id} will be discarded because it was in all caps. body:`, comment.originalBody);
            return shouldDiscard;
        }

        return shouldDiscard;
    }

    newPendingSymbolEntity(initial = {}) { // must provide initial.token
        // returns an initial state for a new "pending symbol". This is not a redis object. It's used during word extraction to temporarily save
        // url/stock/emoji symbol data while they are temporarily represented as simple "symbolUID" strings within comment.body. After natural tokenizing/stemming is complete,
        // these pending symbol entities are re-accessed to restore the comment body to it's original form.
        return {
            token: initial.token, // this is required. It's the untouched token text as originally recieved in comment.body before extraction
            type: initial.type || null, // 'url', 'stock', 'emoji', etc
            normalizedToken: initial.normalizedToken || null, // some symbol tokens will go through normalization logic, like capitalizing stock symbols, or normalizing urls, to maintain their context, while resetting as uniform.
            symbolKey: initial.symbolKey || null, // the redis key that points to the symbol object (may already exist in redis, or this key will be used to save anew)
            matchedSymbol: initial.matchedSymbol || null, // the full redis symbol object for this pending symbol
            assocs: initial.assocs || [] // see the assocs prop documentation on our symbol objectModel
        };
    }

    replaceInCommentBody(comment, replaceStrOrRegex, replaceWith) { // alters comment in-place
        // Because this process forms multiple versions of body, this is a convenience function to perform string replacement uniformly across all.
        if (typeof comment.body === 'string') comment.body = comment.body.replaceAll(replaceStrOrRegex, replaceWith);
        if (typeof comment.normalizedBody === 'string') comment.normalizedBody = comment.normalizedBody.replaceAll(replaceStrOrRegex, replaceWith);
        if (typeof comment.stemmedBody === 'string') comment.stemmedBody = comment.stemmedBody.replaceAll(replaceStrOrRegex, replaceWith);
    }

}

const thisExtractor = new ExtractWordsFromComments();
export default ExtractWordsFromComments;
