// For any process which must create symbol objects to be stored to redis (symbol:url, symbol:stock, symbol:coin, etc).

const symbolObjModel = {

    createSymbolObject: function(props) {
        if (!props.symbol || !props.name) {
            // console.warn(`Cannot create ${props.type} symbol object. Must provide the symbol and name. Got:`, props);
            return null;
        }
        const symbolObj = {
            class: 'symbol',
            symbol: props.symbol, // read-only
            name: props.name || null, // full coin or company name // read-only
            type: props.type || null, // 'stock', 'coin', 'url', etc // read-only
            exchange: props.exchange || null, //nyse, etc // read-only
            assocs: props.assocs || [], // [{assoc: 'http://imgUrl.jpg', type: 'img'}, etc..] - link this symbol to one or more associations with greater context - i.e. an image url for an emoji symbol, etc

            // When extractWordsFromComments is checking each comment token to see if it's a symbol, tokens within the symbolAlias array will also produce a match (in addition to symbol.symbol).
            // i.e. it performs a redis 'get symbol:stock:GME' to confirm a symbol, but we might also want 'get symbol:stock:gamestop' to assign that symbol to the comment. The string 'gamestop'
            // is added to the symbolAlias array via the adminTrain UI (by customizing the get function). Otherwise, symbolAlias is always null.
            symbolAlias: props.symbolAlias || null,
            // Similar to symbolAlias, prettyName can be set via the adminTrain UI (by customizing the get function).  Otherwise, prettyName is always null. This is the name that will render in UI when showing this symbol.
            prettyName:  props.prettyName || null,
            // The following accessor functions are stored to redis as strings. the get and match functions are customizable via adminTrain UI.
            // They are executed via "new Function(getFuncString)". The args seen below are required every time the functions are called.
            // 'get' is the funtion that returns the props for the symbol (allowing programatic edits to symbol.name, for example)
            get: '', // generated below
            // 'match' is the function used when determining if a token should represent this symbol. If the match function returns true (isMatch == true), the host comment for that token
            // gets a comment.symbols entry (which may later become it's comment.topSymbolHigh). The get and match functions are customizable via adminTrain UI, so every symbol has it's custom match code hardcoded into it's redis object.
            match: '', // generated below

            // funcdSymbolData: {}, //obj. this prop is sometimes stored on live objects but must NEVER be persisted to DB. Shown here for documentation only
        };
        symbolObjModel.defaultSymbolFuncString(symbolObj, 'get');
        symbolObjModel.defaultSymbolFuncString(symbolObj, 'match');

        return symbolObj;
    },

    merge: function(existingSymbol, newSymbol) { // updates existingSymbol in place. returns existingSymbol
        // For merging a just created "createSymbolObject" with an existing version of same symbol (pulled from redis)
        // There are some properties that will persist from redis, and some that will be updated to the new values.
        if (newSymbol.symbol) existingSymbol.symbol = newSymbol.symbol;
        if (newSymbol.name) existingSymbol.name = newSymbol.name;
        if (newSymbol.type) existingSymbol.type = newSymbol.type;
        if (newSymbol.exchange) existingSymbol.exchange = newSymbol.exchange;
        if (newSymbol.assocs) {
            newSymbol.assocs.forEach((newAssoc) => {
                let assocExists = existingSymbol.assocs.find(existingAssoc => existingAssoc.assoc === newAssoc.assoc);
                if (!assocExists) existingSymbol.assocs.push(newAssoc);
            });
        }
        // All other props are customized in adminTrain UI and should never be programatically overwritten
        return existingSymbol;
    },

    execGet: function(symbol) {
        if (symbol.funcdSymbolData) return symbol.funcdSymbolData; // looks like this was already run on this live symbol object
        const execFunc = new Function(`const execFunc = (props) => { ${symbol.get} }; return execFunc.apply(undefined, arguments);`);
        try {
            symbol.funcdSymbolData = execFunc({...symbol});
        } catch (error) {
            console.warn(`Symbol (${symbol.symbol}) get function ran with error:`, error);
            symbol.funcdSymbolData = {...symbol};
        }
        return symbol.funcdSymbolData;
    },

    execMatch: function(symbol, matchAgainst) {
        const execFunc = new Function(`const execFunc = (props, matchAgainst) => { ${symbol.match} }; return execFunc.apply(undefined, arguments);`);
        let matchOutcome;
        try {
            matchOutcome = execFunc(symbolObjModel.execGet(symbol), matchAgainst);
        } catch (error) {
            console.warn(`Symbol (${symbol.symbol}) match function ran with error:`, error);
            matchOutcome = false;
        }
        return matchOutcome;
    },

    defaultSymbolFuncString: function(symbolObj, funcName) {
        // alters symbol object in-place
        const defaultFuncStings = {

            'get': `/*
Args available: (props)
Required return value: props (object)
*/

return props;`,

            'match': `/*
Args available: (props, matchAgainst)
Required return value: isMatch (boolean)
*/
let isMatch = false;

/* 1. Exact match */
if (matchAgainst === props.symbol) {
    isMatch = true;
    return isMatch;
}

/* 2. Matches one of our manually defined symbol aliases (set via the symbol get function). Case sensitive. */
if (props.symbolAlias && props.symbolAlias.length) {
    const matchedAlias = props.symbolAlias.find((alias) => {
        return matchAgainst === alias;
    });
    if (matchedAlias) {
        isMatch = true;
        return isMatch;
    }
}

return isMatch;`,

        }; // end defaultFuncStings

        symbolObj[funcName] = defaultFuncStings[funcName];
    },

    generateRedisKey: function(symbolObj){
        return `symbol:${symbolObj.type}:${symbolObj.symbol}`;
    },

    minimizeForDb: function(symbolObj){
        // Run this function on a symbol object before db.set and all props that arent required for persistence will be deleted.
        // RETURNS A SHALLOW COPY! This function will not alter the original symbol obj. First it clones, then returns the clone object.
        // The returned object should be saved immediately and not used for other purposes.
        const symbolClone = { ...symbolObj }; // this is a shallow copy so nested objects should not be altered within this function.

        delete symbolClone.funcdSymbolData; // the outcome from running symbol.execGet. Is held locally on live object, but should NEVER be persisted to DB.

        return symbolClone;
    },

}; // end symbolObjModel


export default symbolObjModel;
