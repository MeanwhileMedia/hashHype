import path from 'path';
import fs from 'fs';
import cloudflare from 'cloudflare';
import flushCDNCacheConfig from './flushCDNCache-config.js';

// This util is used to flush cached assets from cloudflare CDN. Our current cache strategy is to let
// cloudflare cache everything indefinitely, then clear all during a deploy to prod02 (public facing origin server).
class FlushCDNCache {

    constructor() {
        const self = this;
        self.initCloudflareClient(() => {
            self.purgeEverything(() => {
                process.exit();
            });
        });
    }

    initCloudflareClient(cback) {
        const self = this;
        console.log('Connecting cloudflare client...')
        self.cfClient = cloudflare({
            token: flushCDNCacheConfig.token
        });
        if (cback) cback();
    }

    purgeEverything(cback) {
        const self = this;
        console.log('Will now purge everything from cloudflare cache...');
        self.cfClient.zones.purgeCache(flushCDNCacheConfig.zoneId, {purge_everything: true}).then((res) => {
            if (!res.success) {
                console.error(`Failed to purged all cached files from cloudflare. Response:`, res);
                process.exit(1);
                return;
            }
            console.log(`Succesfully purged all cached files from cloudflare zone ${res.result.id}`, res.messages);
            if (cback) cback();
        });
    }

}

const flushCDNCache = new FlushCDNCache();
export default FlushCDNCache;
