/////
// These are quick and dirty natural language utils used primarily for FE rendering of comments. They are
// additional tools to interprest or reverse Natural.js logic (server side) on-the-fly (client side).
// They supplement Natural.js with more specific logic tailored for hashHype functionality.

const natLangLite = {

    porterUnstemmer(stemmedWord) {
        // This will return an array of whole words that the provided stemmedWord MIGHT match according
        // to below (over)generalized rules.
        const possibleWholeWords = [];
        possibleWholeWords.push(stemmedWord);

        // 1. This first rule will compensate for Porter Stemmer which will often be too "aggressive"
        //    while converting "y" to "i" - "buy" is stemmed to "bui"
        let addWholeWords = [];
        possibleWholeWords.forEach((thisWholeWord) => {
            addWholeWords.push(); // JWW stopping
        });
        possibleWholeWords = possibleWholeWords.concat(addWholeWords);
    },

    tenses: [

    ],

    plurality: [

    ],

    suffixes: [

    ]

};

export default natLangLite;
