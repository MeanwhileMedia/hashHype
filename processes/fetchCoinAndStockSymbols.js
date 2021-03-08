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
        setTimeout(self.initFetchLoop, self.fetchLoopIntervalTime);
        self.getRequest(self.getStockSymbolEndpoint(), (stockSymbolsCsv) => {
            self.getRequest(self.getCoinSymbolEndpoint(), (coinSymbolsCsv) => {
                const allFetchedSymbols = [];

                const stockSymbolsData = stockSymbolsCsv.split(/\r?\n/);
                stockSymbolsData.forEach((thisStock, index) => {
                    const thisStockData = thisStock.split(',');
                    const stockObj = self.createSymbolObject({
                        symbol: thisStockData[0],
                        name: thisStockData[1],
                        type: 'stock',
                        exchange: thisStockData[2]
                    });
                    if (stockObj) allFetchedSymbols.push(stockObj);
                });

                const coinSymbolsData = coinSymbolsCsv.split(/\r?\n/);
                coinSymbolsData.forEach((thisCoin, index) => {
                    const thisCoinData = thisCoin.split(',');
                    const coinObj = self.createSymbolObject({
                        symbol: thisCoinData[0],
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
        return {
            symbol: props.symbol,
            name: props.name || null, // full coin or company name
            type: props.type || null, // 'stock' or 'coin'
            exchange: props.exchange || null, //nyse, etc
        }
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
            self.redisClient.set(`symbol:stock:${symbol.symbol}`, JSON.stringify(symbol));
        });
    }

}

const thisFetchCoinAndStockSymbols = new FetchCoinAndStockSymbols();
export default FetchCoinAndStockSymbols;
