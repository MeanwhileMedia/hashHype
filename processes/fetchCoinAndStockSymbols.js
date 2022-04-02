import https from 'https';
import yargs from 'yargs';
import RedisClient from '../utils/redisClient.js';
import symbolModel from '../utils/objectModels/symbol.js';

const argv = yargs(process.argv.slice(2)).argv;

class FetchCoinAndStockSymbols {
    constructor() {
        const self = this;
        //Config options
        this.alphaVantage = {
            apiKey: '9YGMD3F2NIKWO4CZ',
        }
        this.fetchLoopIntervalTime = 43200000; // every 12 hours

        this.interceptSigInt();

        console.log('A new fetchCoinAndStockSymbols process has just started...');
        this.redisClient = null;
        this.initRedisClient(() => {
            self.initFetchLoop();
        });
    }

    interceptSigInt() {
        const self = this;
        // By intercepting the SIGINT shutdown signal, this process can call any wrap-up routines before the process closes. https://pm2.keymetrics.io/docs/usage/signals-clean-restart/
        process.on('SIGINT', function() {
            self.redisClient.kill(() => {
                process.exit(0);
            });
        });
    }

    initRedisClient(cback) {
        const self = this;
        self.redisClient = new RedisClient({
            onConnect: (client) => {
                console.log('Connected to locally hosted redis DBs for FetchCoinAndStockSymbols class.');
                if(cback) cback();
            }
        });
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
                        symbol: symbol.toUpperCase(), // this prop is ALWAYS uppercased for consistency
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
                        symbol: symbol.toUpperCase(),
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
        symbols.forEach((symbol) => {
            const symbolKey = `symbol:${symbol.type}:${symbol.symbol}`;
            self.redisClient.get(symbolKey, (gotSymbol) => {
                if (gotSymbol) {
                    const existingSymbol = gotSymbol;
                    symbol = symbolModel.merge(existingSymbol, symbol);
                }
                self.redisClient.set(symbolKey, symbolModel.minimizeForDb(symbol));
            });
        });
    }

}

const thisFetchCoinAndStockSymbols = new FetchCoinAndStockSymbols();
export default FetchCoinAndStockSymbols;
