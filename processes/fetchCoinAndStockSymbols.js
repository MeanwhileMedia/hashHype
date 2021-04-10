import https from 'https';
import RedisClient from '../utils/redisClient.js';
import symbolModel from '../utils/objectModels/symbol.js';

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
                    const stockObj = symbolModel.createSymbolObject({
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
                    const coinObj = symbolModel.createSymbolObject({
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

    storeSymbolsToRedis(symbols) {
        const self = this;
        if (!this.redisDbClient) {
            new RedisClient({
                dbName: 'short',
                onConnect: (client) => {
                    console.log('Connected new redis client for fetch coin and stock symbols class.');
                    self.redisDbClient = client;
                    self.storeSymbolsToRedis(symbols);
                }
            });
            return;
        }
        symbols.forEach((symbol) => {
            const symbolKey = `symbol:${symbol.type}:${symbol.symbol}`;
            self.redisDbClient.get(symbolKey, (err, json) => {
                if (err) {
                    console.log(err);
                    return;
                }
                if (json) {
                    const existingSymbol = JSON.parse(json);
                    symbol = symbolModel.merge(existingSymbol, symbol);
                }
                self.redisDbClient.set(symbolKey, JSON.stringify(symbol));
            });
        });
    }

}

const thisFetchCoinAndStockSymbols = new FetchCoinAndStockSymbols();
export default FetchCoinAndStockSymbols;
