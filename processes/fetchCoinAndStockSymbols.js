import https from 'https';
import RedisClient from '../utils/redisClient.js';

class FetchCoinAndStockSymbols {
    constructor() {
        //Config options
        this.alphaVantage = {
            apiKey: '9YGMD3F2NIKWO4CZ',
        }
        this.fetchLoopIntervalTime = 43200000; // every 12 hours
        this.initFetchLoop();
    }

    initFetchLoop() {
        const self = this;
        console.log('Now fetching list of all stock and coin symbols...');
        setTimeout(self.initFetchLoop.bind(self), self.fetchLoopIntervalTime);
        self.getRequest(self.getStockSymbolEndpoint(), (stockSymbolsCsv) => {
            self.getRequest(self.getCoinSymbolEndpoint(), (coinSymbolsCsv) => {
                const allFetchedSymbols = [];

                const stockSymbolsData = stockSymbolsCsv.split(/\r?\n/);
                stockSymbolsData.forEach((thisStock, index) => {
                    const thisStockData = thisStock.split(',');
                    let symbol = thisStockData[0]; // Our alphavantage data will add "-this-that" to symbols. I.e: Goldman Sachs (symbol GS) is returned as "GS-P-D". We remove this extra info before saving.
                    symbol = symbol.split('-')[0];
                    const stockObj = self.createSymbolObject({
                        symbol: symbol.toLowerCase(), // this prop is ALWAYS lowercased to be consistent with how we stored redis keys and words
                        name: thisStockData[1],
                        type: 'stock',
                        exchange: thisStockData[2]
                    });
                    if (stockObj) allFetchedSymbols.push(stockObj);
                });

                const coinSymbolsData = coinSymbolsCsv.split(/\r?\n/);
                coinSymbolsData.forEach((thisCoin, index) => {
                    const thisCoinData = thisCoin.split(',');
                    let symbol = thisCoinData[0];
                    symbol = symbol.split('-')[0];
                    const coinObj = self.createSymbolObject({
                        symbol: symbol.toLowerCase(), // this prop is ALWAYS lowercased to be consistent with how we stored redis keys and words
                        name: thisCoinData[1],
                        type: 'coin'
                    })
                    if (coinObj) allFetchedSymbols.push(coinObj);
                });

                console.log(`Fetched data for ${allFetchedSymbols.length} new symbols.`);
                self.storeSymbolsToRedis(allFetchedSymbols);
            });
        });
    }

    getRequest(url, cback) {
        https.get(url, (res) => {
            let data = "";
            res.on("data", (d) => {
                data += d
            });
            res.on("end", () => {
                if (cback) cback(data);
            });
        });
    }

    getStockSymbolEndpoint() {
        return `https://www.alphavantage.co/query?function=LISTING_STATUS&apikey=${this.alphaVantage.apiKey}`; // csv
    }
    getCoinSymbolEndpoint() {
        return `https://www.alphavantage.co/digital_currency_list/`; // currently a static endpoint to csv
    }

    createSymbolObject(props) {
        if (!props.symbol || !props.name) {
            //console.log(`Cannot create ${props.type} symbol object. Must provide the symbol and name.`);
            return null;
        }
        const symbolObj = {
            symbol: props.symbol,
            name: props.name || null, // full coin or company name
            type: props.type || null, // 'stock', 'coin', 'url', etc
            exchange: props.exchange || null, //nyse, etc
            // The following accessor functions are stored to redis as strings. the get and match functions are customizable via adminTrain UI.
            // They are executed via "new Function(getFuncString)". The args seen below are required every time the functions are called.
            // 'get' is the funtion that returns the props for the symbol (allowing programatic edits to symbol.name, for example)
            get: '', // generated below
            // 'match' is the function used when determining if a word/bigram/trigram contains this symbol. By default, it checks each word part of matchAgainst (trigram_example_gme) for an
            // exact match to symbol.symbol.toLowerCase(). If found, this custom match is run AFTER the default match logic, with it's arg "isMatch" initially true.
            // The outcome of our default match logic is passes to this secondary match function via the (isMatch) argument.
            match: '' // generated below
        };
        this.defaultSymbolFuncString(symbolObj, 'get');
        this.defaultSymbolFuncString(symbolObj, 'match');

        return symbolObj;
    }

    defaultSymbolFuncString(symbolObj, funcName) {
        // alters symbol object in-place
        const defaultFuncStings = {
            'get': '/*\nArgs available: (props)\nRequired return value: props (object)\n*/\nreturn props;',
            'match': '/*\nArgs available: (props, matchAgainst, isMatch)\nRequired return value: isMatch (boolean)\n*/\nreturn isMatch;'
        };

        if (symbolObj.type === 'stock') {
            defaultFuncStings.match = `/*
Args available: (props, matchAgainst, isMatch)
Required return value: isMatch (boolean)
*/

/* 1. Stock symbols must be commented in all caps */
const allCapsSymbol = props.symbol.toUpperCase();
if (matchAgainst.indexOf(allCapsSymbol) === -1) isMatch = false;

return isMatch;`
        }

        symbolObj[funcName] = defaultFuncStings[funcName];

        ///////////
        // Example of how the stringified accessor functions are called:
        // exampleSymbol.match = `
        //   console.log('foo', arg1);
        //   console.log('bar', arg2);
        // `;
        // const matchFunc = new Function(`const execFunc = (arg1, arg2) => { ${exampleSymbol.match} }; return execFunc.apply(undefined, arguments);`);
        // matchFunc('lorem', 'ipsum'); // this will be called inside a try/catch becuase of it's variable nature.
        // // Outputs foo lorem bar ipsum
    }

    storeSymbolsToRedis(symbols) {
        const self = this;
        if (!this.redisClient) {
            new RedisClient({
                onConnect: (client) => {
                    console.log('Connected new redis client for fetch coin and stock symbols class.');
                    self.redisClient = client;
                    self.storeSymbolsToRedis(symbols);
                }
            });
            return;
        }
        symbols.forEach((symbol) => {
            self.redisClient.set(`symbol:${symbol.type}:${symbol.symbol}`, JSON.stringify(symbol));
        });
    }

}

const thisFetchCoinAndStockSymbols = new FetchCoinAndStockSymbols();
export default FetchCoinAndStockSymbols;
