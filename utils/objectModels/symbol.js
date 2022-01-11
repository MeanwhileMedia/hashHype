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
            // The following accessor functions are stored to redis as strings. the get and match functions are customizable via adminTrain UI.
            // They are executed via "new Function(getFuncString)". The args seen below are required every time the functions are called.
            // 'get' is the funtion that returns the props for the symbol (allowing programatic edits to symbol.name, for example)
            get: '', // generated below
            // 'match' is the function used when determining if a word/bigram/trigram contains this symbol. By default, it checks each word part of matchAgainst (trigram_example_gme) for an
            // exact match to symbol.symbol.toUpperCase(). If found, this custom match is run AFTER the default match logic, with it's arg "isMatch" initially true.
            // The outcome of our default match logic is passes to this secondary match function via the (isMatch) argument.
            match: '' // generated below
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

    execMatch: function(symbol, matchAgainst, isMatch) {
        const execFunc = new Function(`const execFunc = (props, matchAgainst, isMatch) => { ${symbol.match} }; return execFunc.apply(undefined, arguments);`);
        let matchOutcome;
        try {
            matchOutcome = execFunc(symbol, matchAgainst, isMatch);
        } catch (error) {
            console.warn(`Symbol (${symbol.symbol}) match function ran with error:`, error);
            matchOutcome = false;
        }
        return matchOutcome;
    },

    defaultSymbolFuncString: function(symbolObj, funcName) {
        // alters symbol object in-place
        const defaultFuncStings = {
            'get': '/*\nArgs available: (props)\nRequired return value: props (object)\n*/\nreturn props;',
            'match': '/*\nArgs available: (props, matchAgainst, isMatch)\nRequired return value: isMatch (boolean)\n*/\nreturn isMatch;'
        };

        if (symbolObj.type === 'stock' || symbolObj.type === 'coin') {
            defaultFuncStings.match = `/*
Args available: (props, matchAgainst, isMatch)
Required return value: isMatch (boolean)
*/

/* 1. Stock symbols must be commented in all caps */
const allCapsSymbol = props.symbol.toUpperCase();
if (matchAgainst.indexOf(allCapsSymbol) === -1) {
  isMatch = false;
}

return isMatch;`
        }

        symbolObj[funcName] = defaultFuncStings[funcName];
    }

}; // end symbolObjModel


export default symbolObjModel;
