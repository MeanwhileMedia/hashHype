// This is the only manually curated static list of tokens that is used as part of hashHypes natural language
// processing logic. These words are stripped from comment.stemmedBody from the very beginning and not only makes
// topCommentStats more accurate, but more performant on CPU/mem. This list is much more lightweight than
// the one that comes with natural js because hashHypes algo is efficient enough to allow, and draw meaning from many
// of the most common english words. We really only need to exlude article and some transitional words.

// The 'remove' list are words which will be totally omitted when forming comment.stemmedBody. These words will play no role in building word sequences, or earning points.
const remove = [ // these are matched again NON-STEMMED tokens inside the extractWordsFromComments stemToken() function.
    'a',
    'am',
    'an',
    'are',
    'as',
    'but',
    'by',
    'for',
    'is',
    'it',
    'its',
    'of',
    'so',
    'that',
    'the',
    'these',
    'this',
    'those',
    'was',
    'were',
    'what',
    'which',

    // Reserved charachter sequences for hashHype (delimeters etc.)
    '_',
    '_!!_',
    ' ',
];

// The 'ignore' list are words that stay in comment.stemmedBody, and can be part of bi/tri/2d word sequences, but they DO NOT earn points. See topCommentStats.getWordPointCount for pointing logic.
// This allows certain meaningful phrases like "can not" to be part of trigrams/2dGrams, but on their own, they have no meaning or value and get no points.
const ignore = [ // these are matched against STEMMED tokens during getWordPointCount
    'can',
    'will',
    'do',
    'doe', //does
    'did',
    'have',
    'if',
    'or',
    'and',
    'i',
    'you',
    'thei', //they
    'them',
    'we',
    'from',
    'to',
    'not',
    'would',
    'be',
    'being'
];

export default {remove, ignore};
