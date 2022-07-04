import wordModel from './objectModels/word.js';

const extract2dGramsFromComment = {

    minTokenClusterLengthFor2dGram: 4, // this must always be greater than our longest word type (trigrams) otherwise we will have key conflicts in redis over the 2dGram vs trigram version of it.
    maxTokenClusterLengthFor2dGram: 10, // If we don't set a max then some comments which managed to have a high number of pointed tokens could overflow memory while 2dGram logic below tries to compute tens of thousands of combinations. We must assume that a comment with this many pointed words has diluted any potential for useful 2dGrams.

    extract: (comment, redisClient, cback) => { //alters comment in-place. cback returns an array of all 2dGrams currently in comment.
        // This is the last step (before saving to redis) performed on every newly pointed comment that has been deemed a topComment. We will inspect all words (word sequences) in this comment which have earned points,
        // and generate 2dGrams. 2dGrams are clustered word sequences that represent order. Then, future comments can earn points not just for re-commenting the same word sequences, but for commenting two or more
        // word sequences IN THE SAME ORDER as a past comment. For example:
        // Step 1: A new (stemmed) comment 'Hey reddit guy insane stuff GME is awesome and is going rocket moon Makes me happy comment about stocks and money'
        // Step 2: Some time passes and other users comment "guy_!!_insane" and "GME" and "going_!!_rocket_!!_moon" and "happy_!!_comment". extractNew2dGramsFromTopComment will create the following 2dGrams ONLY from the sequences which have earned points:
            // [ 'guy_!!_insane + GME', (clusters of 2)
            //   'GME + going_!!_rocket_!!_moon',
            //   'going_!!_rocket_!!_moon + happy_!!_comment',
            //   'guy_!!_insane + GME + going_!!_rocket_!!_moon', (clusters of 3)
            //   'GME + going_!!_rocket_!!_moon + happy_!!_comment',
            //   'guy_!!_insane + GME + going_!!_rocket_!!_moon + happy_!!_comment', (clusters of 4)
            //   etc... there is currently no limit on how long a cluster can be (other than the comment length max), and longer clusters are awarded more points when re-commented.
            // ]
        // Step 3: Each new 2dGram is saved as a new redis word entity, and added to wordToCommentsIndex and foundAt list - just like our symbols/bigrams/trigrams.
        // Step 4: More time passes, and new comments contain the same 2dGrams, receive points accordingly (see applyPointsToCommentForWord). Note that when a comment creates a new 2dgram within itself for the first time, it does not gain points until the next time.
        const self = extract2dGramsFromComment;
        let allNew2dGramStrings = null; // array wordRef.word strings (of word.type == 2dGram) produced by this function (but ONLY new 2dGrams for this topComments refresh. There may have already been 2dGrams on this comment - they are not returned in allNew2dGramStrings.)

        //////////
        // If this comment has less than 2 words which have earned, or will soon earn points, then we can't create a 2dGram and should return immediately.
        const pointedWordsForComment = Object.keys(comment.points);
        if (pointedWordsForComment < 2) {
            // console.log(`comment:${comment.id} does not have enough pointed words to create any 2dGrams.`);
            if (cback) cback(allNew2dGramStrings);
            return;
        }

        /////////
        // Now count JUST the new word occurances which are valid to produce new 2dGrams. If none are, can return immediately.
        const validNewWordsFor2dGram = [];
        pointedWordsForComment.forEach((thisPointedWord) => { // newlyPointedWordsForComment will not contain any dups when passed to extractNew2dGramsFromTopComment
            if (comment.points[thisPointedWord] === 0 || // words that had their points adjusted down to 0 (because of word overlap or other) are not valid to be part of a 2dGram
                comment.words[thisPointedWord].type === '2dGram' || // obvi 2dGrams can't combine to create more 2dGrams
                comment.wordsFor2dGram.indexOf(thisPointedWord) !== -1 // This newly pointed word was already accounted for in a previous iteration of extractNew2dGramsFromTopComment. comment.wordsFor2dGram is the record persisted to comment object to make this repeat comparison more performant
            ) {
                return;
            }
            validNewWordsFor2dGram.push(thisPointedWord);
        });
        if (validNewWordsFor2dGram.length === 0) {
            // console.log(`Already created all 2dGrams for comment:${comment.id} which could result from incoming points for words:`, comment.points);
            if (cback) cback(allNew2dGramStrings);
            return;
        }

        /////////
        // We now know that we should proceed with below (heavy) logic. Combine all new and old words which are valid to create 2dGrams together.
        const validWordsFor2dGram = comment.wordsFor2dGram.concat(validNewWordsFor2dGram);
        comment.wordsFor2dGram = validWordsFor2dGram; // and update our cached record on comment now that it's changed

        ///////////
        // Now take all the pointed words for this comment, condense them, and get them in the correct order.
        // We use a charachter index map because some of the pointed word sequences will overlap and we can only count each token once (i.e. "guy_!!_insane" AND "guy_!!_insane_!!_stuff" both earned points)
        let pointedCharsOrdered = {}; // {'{charIndex11}': 'g', '12': 'u', '13': 'y', '14': ' ', '15': 'i', '16': 'n', '17': 's', '18': 'a', '19': 'n', '20': 'e', '27': ' ', '28': 'G', '29': 'M', etc...}
        let lowestCharIndex = null;
        let highestCharIndex = 0;
        let totalTokenCount = 0;
        validWordsFor2dGram.forEach((thisValidWordStr) => {
            const thisWordRef = comment.words[thisValidWordStr];
            if (!thisWordRef) return;
            const thisWordString = thisWordRef.word.replaceAll('_!!_', ' '); // For this logic our word delimeter must be only 1 char (because our word indexes are based on a stemmed body with single space delimeters)
            thisWordRef.index.forEach((thisIndex) => { // remember that a word sequence may occur more than once in a single comment
                const startIndex = thisIndex;
                for (let curIndex = startIndex; curIndex < startIndex+thisWordString.length; curIndex++) {
                    if (pointedCharsOrdered[curIndex]) {
                        // we have a word overlap - prob between a bigram/trigram. Make sure we preserve all rawWords from both
                        pointedCharsOrdered[curIndex].rawWords = pointedCharsOrdered[curIndex].rawWords.concat(thisWordRef.rawWords);
                        pointedCharsOrdered[curIndex].hasSymbols = pointedCharsOrdered[curIndex].hasSymbols.concat(thisWordRef.hasSymbols);
                    } else {
                        const thisChar = thisWordString[curIndex-startIndex];
                        pointedCharsOrdered[curIndex] = {
                            index: curIndex,
                            char: thisChar,
                            rawWords: thisWordRef.rawWords,
                            hasSymbols: thisWordRef.hasSymbols
                        };
                        if (thisChar === ' ') ++totalTokenCount;
                    }
                    if (curIndex > highestCharIndex) highestCharIndex = curIndex;
                    if (lowestCharIndex === null || curIndex < lowestCharIndex) lowestCharIndex = curIndex;

                    if (typeof pointedCharsOrdered[curIndex-1] === 'undefined' && curIndex !== 0) {
                        pointedCharsOrdered[curIndex-1] = {index: curIndex-1, char: ' ', rawWords: [], hasSymbols: []}; // Prob just jumped between two words. Make sure we represent the distance between in pointedCharsOrdered via a single space.
                        if (lowestCharIndex === null || curIndex-1 < lowestCharIndex) lowestCharIndex = curIndex-1;
                        ++totalTokenCount;
                    }
                }
            });
        });
        if (highestCharIndex) { // make sure the last token also has a trailing space for below logic.
            pointedCharsOrdered[highestCharIndex+1] = {index: highestCharIndex+1, char: ' ', rawWords: [], hasSymbols: []};
            ++totalTokenCount;
        }
        if (lowestCharIndex && pointedCharsOrdered[lowestCharIndex].char === ' ') { // make sure the first token does not have a preceding space. If so, we counted one too many tokens above.
            delete pointedCharsOrdered[lowestCharIndex];
            --totalTokenCount;
        }
        // console.log('comment.stemmedBody', comment.id, comment.stemmedBody);
        // console.log('pointedCharsOrdered', pointedCharsOrdered);
        // console.log('totalTokenCount', totalTokenCount);


        ///////////////
        // Now that all charachters from all pointed words have been parsed together in order, and all symbols/raw words are still associated with each charachter (pointedCharsOrdered), let's combine
        // those charachters back together into an ordered array of wordRefs (pointedWordsOrdered). We can then use that array to run ngrams and get all possible combos, this includes "skip word" combos. i.e:
        // Given ['guy', 'insane', 'GME', 'going', 'rocket', 'moon', 'happy', 'comment']
        // 2dgrams would include guy_!!_insane_!!_GME_!!_going_!!_rocket  AND  guy_!!_GME_!!_going_!!_rocket  (and all other permutations that exceed minTokenClusterLengthFor2dGram)
        const pointedWordsOrdered = []; // array of wordrefs
        let curExtractingToken = '';
        let curExtractingTokenIndex = 0;
        let curExtractingTokenRawWords = [];
        let curExtractingTokenHasSymbols = [];
        let prevCharObj = null;
        for (let [thisCharObjIndex, thisCharObj] of Object.entries(pointedCharsOrdered)) {
            if (curExtractingToken === '') {
                // just started a new token.
                curExtractingTokenIndex = thisCharObj.index;
            }

            if (thisCharObj.char === ' ' && curExtractingToken.length > 0) {
                // just completed a token.
                const newWordRefObject = wordModel.createWordRefObject({
                    type: '2dGram-pending', // this is pseudo type just to assist computations. This wordRef will not be saved to DB, it will be used to construct 2dGrams below.
                    word: curExtractingToken,
                    rawWords: prevCharObj.rawWords || [],
                    hasSymbols: prevCharObj.hasSymbols || [],
                    index: [curExtractingTokenIndex], // remember that wordRefs use an array for index
                });
                pointedWordsOrdered.push(newWordRefObject);

                // reset all loop refs
                curExtractingToken = '';
                curExtractingTokenIndex = 0;
                curExtractingTokenRawWords = [];
                curExtractingTokenHasSymbols = [];
                continue;
            }

            if (thisCharObj.char !== ' ') {
                prevCharObj = thisCharObj;
                curExtractingToken = curExtractingToken + thisCharObj.char;
            }
        }
        // console.warn('stemmedBody', comment.stemmedBody);
        // console.warn('pointedCharsOrdered', pointedCharsOrdered);
        // console.warn('validWordsFor2dGram', validWordsFor2dGram);
        // console.warn('pointedWordsOrdered', pointedWordsOrdered);
        if (pointedWordsOrdered.length < self.minTokenClusterLengthFor2dGram) {
            // console.warn(`comment:${comment.id} does not have enough pointed tokens to create any 2dGrams (${pointedWordsOrdered.length}/${self.minTokenClusterLengthFor2dGram}).`);
            if (cback) cback(allNew2dGramStrings);
            return;
        }
        if (pointedWordsOrdered.length > self.maxTokenClusterLengthFor2dGram) {
            // console.warn(`comment:${comment.id} has too many pointed tokens to compute all possible 2dGram combinations (${pointedWordsOrdered.length}/${self.maxTokenClusterLengthFor2dGram}).`);
            if (cback) cback(allNew2dGramStrings);
            return;
        }

        // Now get all possible combinations of above produced pointedWordsOrdered, then form all of those combinations into 2dGram wordRefs.
        const allWordClusters = self.extractAllWordCombos(pointedWordsOrdered, self.minTokenClusterLengthFor2dGram); // returns array of arrays of objects: [{wordRef: wordRefObj, index: int}, etc...]
        // console.log(`comment:${comment.id} had ${pointedWordsOrdered.length} pointed words which produced ${allWordClusters.length} possible word combinations to form 2dGrams.`);
        const all2dGrams = [];
        allWordClusters.forEach((thisWordCluster) => {
            // Convert thisWordCluster (array of objects [{wordRef: wordRefObj, index: int}, etc...]) into a single 2dGram wordRef
            const this2dGram = wordModel.createWordRefObject({
                type: '2dGram',
                word: [], // this MUST be a string of wordRef. Will join below after all parts are added.
                rawWords: [],
                hasSymbols: [],
                index: [], // remember that wordRefs use an array for index (even though 2dGrams only ever have one index)
                rawIndex: [],
                distance: 0
            });
            let prevTokenEndIndex = null; // so we can total the distance between all tokens in this combo
            thisWordCluster.forEach((thisClusterPart) => { // each thisClusterPart is object {wordRef: wordRefObj, index: int}
                const thisClusterPartWordRef = thisClusterPart.wordRef;
                this2dGram.word.push(thisClusterPartWordRef.word);
                this2dGram.rawWords = this2dGram.rawWords.concat(thisClusterPartWordRef.rawWords);
                this2dGram.hasSymbols = this2dGram.hasSymbols.concat(thisClusterPartWordRef.hasSymbols);
                if (!this2dGram.index[0] || thisClusterPartWordRef.index[0] < this2dGram.index[0]) this2dGram.index[0] = thisClusterPartWordRef.index[0];
                if (prevTokenEndIndex !== null) {
                    this2dGram.distance = this2dGram.distance + (thisClusterPartWordRef.index[0] - (prevTokenEndIndex+2)); // +2 because we don't count a single space between tokens as distance, nor the first charachter in this current word.
                }
                prevTokenEndIndex = thisClusterPartWordRef.index[0]-1 + thisClusterPartWordRef.word.length; // this is the index of the final charachter in the previous token
            });


            ///////////
            // HashHype rule - 2dGrams with a distance of 0 are invalid. The point of a 2dGram is to frame an unpointed portion of a comment between 2 or more pointed portions.
            // If a 2dGram is back-to-back pointed words, then we simply allow those words to earn their points individually (a smaller sum). This also helps eliminate the potential
            // for inflated points when a user is simply quoting another user (whether that quote is sincere, or an attempt to game points).
            if (this2dGram.distance === 0) {
                // console.warn(`Discarding 2dGram with a distance of 0 on comment:${comment.id}:`, comment.stemmedBody);
                // console.warn(`Discarded 2dGram:`, this2dGram);
                return; // continue allWordClusters.forEach loop so this invalid 2dGram isn't pushed to all2dGrams.
            }

            //////////
            // HashHype rule - A word sequence can't earn points if it's length is greater than 70% the length of the entire comment body. This blocks comments from
            // earning tons of 2dGram points when many users are quoting the same phrase but not adding anything original to it. We only apply this rule to long comments (greater than
            // minCommentLengthForMaxWordLengthRule) because there are so many short comments that have key phrases which are understandably most of that short comment body.
            // I.e: "you know you are a redneck when GME" does not deserve to launch GME to rank 1 comment.
            const minCommentLengthForMaxWordLengthRule = 70;
            const maxWordSeqLength = 0.7; // a percentage of the length of comment.stemmedBody
            if (comment.stemmedBody.length >= minCommentLengthForMaxWordLengthRule) {
                const thisWordStrSpaced = this2dGram.word.join(' ');
                const thisWordStrLength = thisWordStrSpaced.length + this2dGram.distance;
                const wordStringPercOfBody = thisWordStrLength / comment.stemmedBody.length;
                if (wordStringPercOfBody > maxWordSeqLength) {
                    // console.warn(`2dGram sequence was too long and will not be saved to comment. The 2dGram spanned ${wordStringPercOfBody * 100}% of the entire body comment:${comment.id}`, this2dGram.word);
                    return; // continue allWordClusters.forEach loop so this invalid 2dGram isn't pushed to all2dGrams.
                }
            }

            // remove dups
            this2dGram.rawWords = [...new Set(this2dGram.rawWords)];
            this2dGram.hasSymbols = [...new Set(this2dGram.hasSymbols)];

            // Now we must also establish rawIndex for this 2dGram using the combined rawWords
            let rawIndex = null;
            this2dGram.rawWords.forEach((thisRawWordSeq) => {
                const thisRawIndex = comment.body.indexOf(thisRawWordSeq);
                if (thisRawIndex === -1) return;
                // For 2dGrams, we will only ever have 1 index and rawIndex. For rawIndex, we are going to take the index of the first rawWord occurance.
                if (rawIndex === null || rawIndex > thisRawIndex) rawIndex = thisRawIndex;
            });
            this2dGram.rawIndex[0] = rawIndex;

            // Finally ready to save this new 2dGram wordRef
            all2dGrams.push(this2dGram);
        });


        ////////////
        // Last, save our the above 2dGram wordRef objects to our comment.words object, then also create full word objects for the 2dGrams and save to redis.
        allNew2dGramStrings = [];
        const wordRefSavePromises = [];
        const wordSavePromises = [];
        all2dGrams.forEach((this2dGram) => {
            this2dGram.word = this2dGram.word.join('_!!_'); // convert it to it's proper string form now.
            // add wordRef to comment
            if (!comment.words[this2dGram.word]) { // first check if already exists
                // console.warn(`comment:${comment.id} earned a new 2dGram: ${this2dGram.word}`, this2dGram)
                comment.words[this2dGram.word] = this2dGram; // This comment will be saved at the bottom of refreshTopComments
                wordRefSavePromises.push(new Promise( (resolve, reject) => {
                    wordModel.registerWordOccurance(this2dGram, comment, redisClient, () => {
                        allNew2dGramStrings.push(this2dGram.word);
                        resolve();
                    });
                })); // end wordRefSavePromises.push
            }
        }); //end all2dGrams.forEach(

        Promise.all(wordRefSavePromises).then(() => {
            // WARNING - extract2dGramsFromComment does NOT save the comment after altering it in-place. It also doesn't calculate points for extracted 2dGrams. That will be left to the process that called this util.
            if (cback) cback(allNew2dGramStrings);
        });
    },

    extractAllWordCombos: (wordRefs = [], minComboLength = 4) => { // returns array of arrays of objects: [[{wordRef: wordRefObj, index: int}, etc...], [{wordRef: wordRefObj, index: int}, etc...], etc...]
        if (!wordRefs || !wordRefs.length) return [];
        // This function takes an array of wordRef objects and returns all possible combinations of those words, respecting order.
        // However, it does allow for "skip words", or, a combination of words which one or more words is omitted from the middle.
        // When minComboLength is greater than 0, and produced cominations of shorter length will be discarded and not returned.
        // i.e: given: ['guy', 'insane', 'GME', 'going', 'rocket', 'moon', 'happy', 'comment'] and minComboLength = 4
        // some possible wordCombos could be: ['guy', 'insane', 'GME', 'going'] AND ['guy', 'GME', 'going', 'rocket'] or ['insane', 'rocket', 'happy', 'comment'], ['insane', 'GME', 'rocket', 'happy', 'comment'] etc...

        // First extract all possible pairs of 2, then they will be extended below in recursive "combineSkipWords" function.
        const allSkipWordsSets = [];
        const allPossibleTokenClusters = []; // array of arrays of wordRefs
        wordRefs.forEach((startingPointedWord, startingWordIndex) => {
            const thisWordSubset = wordRefs.slice(startingWordIndex);
            if (thisWordSubset.length < 2) return;

            // thisSkipWordSet is array of arrays. always the first word (thisWordSubset[0]) plus 1 other word which comes later than the first.
            // Given ['guy', 'insane', 'GME', 'going', 'rocket', 'moon', 'happy', 'comment']
            // skipWords == [['guy', 'insane'], ['guy', 'GME'], ['guy', 'going'], ['guy', 'rocket'], ['guy', 'moon']]
            // Note below that our skipword arrays actually hold objects not strings. Above is for explanation only.
            const thisSkipWordSet = [];
            const totalPossibleSkipWords = thisWordSubset.length - 1;
            for (let thisSkipWordCount = 0; thisSkipWordCount < totalPossibleSkipWords; thisSkipWordCount++) {
                const endIndex = thisSkipWordCount+1;
                ///////////
                // HashHype rule - a 2dGram can't have the same token twice in a row. I.e: "I love GME go moon :smile_emoji: :smile_emoji: :smile_emoji: Let's go!"
                // Now we will loop through thisTokenSet and condense any sequence of the same word into just one occurance: "I love GME go moon :smile_emoji: Let's go!"
                if (thisWordSubset[0].word === thisWordSubset[endIndex].word) {
                    // console.log(`Dup sequential words are not allowed:`, thisWordSubset[0].word, thisWordSubset[endIndex].word);
                    continue;
                }
                thisSkipWordSet.push([
                    {wordRef: thisWordSubset[0], index: startingWordIndex},
                    {wordRef: thisWordSubset[endIndex], index: startingWordIndex+endIndex}
                ]);
            }

            allSkipWordsSets.push(thisSkipWordSet);
        });

        // This takes all possible pairs of 2 words (from above), then loops over each of them, recursively extending beyond the last word in each set
        // until we have all possible combinations of all lengths (greater than or equal to minComboLength).
        const combineSkipWords = (curSkipWordsByWord, allCombinations = []) => {
            let foundNewCombosThisLoop = false; // once this recursive function has extended all skipWord combos to be as long as possible, this flag remains false and we return the final val from this function.
            const newSkipWordCombos = [];
            curSkipWordsByWord.forEach((thisSkipWordsSet, thisSkipWordsSetIndex) => {
                newSkipWordCombos[thisSkipWordsSetIndex] = newSkipWordCombos[thisSkipWordsSetIndex] || [];
                thisSkipWordsSet.forEach((thisSkipWords) => {
                    const appendableSkipWords = curSkipWordsByWord[thisSkipWords[thisSkipWords.length-1].index]; // which skip word combos can possibly follow thisSkipWords[0]
                    if (!appendableSkipWords || !appendableSkipWords.length) {
                        newSkipWordCombos[thisSkipWordsSetIndex].push(thisSkipWords);
                        return;
                    }
                    foundNewCombosThisLoop = true;
                    appendableSkipWords.forEach((thisAppendableSkipWords) => {
                        const appendThese = thisAppendableSkipWords.slice(1);
                        const thisCombo = thisSkipWords.concat(appendThese);
                        newSkipWordCombos[thisSkipWordsSetIndex].push(thisCombo);
                        if (thisCombo.length >= minComboLength) allCombinations.push(thisCombo);
                    });
                });
            });

            if (!foundNewCombosThisLoop) {
                return allCombinations;
            } else {
                return combineSkipWords(newSkipWordCombos, allCombinations);
            }
        }

        const allWordClusters = combineSkipWords(allSkipWordsSets); // the result of combining all possible permutations of skipwords
        return allWordClusters;
    } // end extractAllWordCombos


}; // end extract2dGramsFromComment


export default extract2dGramsFromComment;
