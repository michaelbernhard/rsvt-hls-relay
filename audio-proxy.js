const http = require('http');
const https = require('https');

const STREAMS = {
    '/live.mp3': {
        url: 'http://stream.radiojar.com/c1wchedg76bwv',
        name: 'Reservatet.fm LIVE'
    },
    '/bloede.mp3': {
        url: 'http://stream.radiojar.com/4hge3m401bpwv',
        name: 'Bløde Bølger'
    }
};

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const streamConfig = STREAMS[url] || STREAMS['/live.mp3'];

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Connection', 'keep-alive');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    function pipeRadiojar(targetUrl) {
        const client = targetUrl.startsWith('https:') ? https : http;
        const upstreamReq = client.get(targetUrl, {
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Sonos Speaker (HiFi)',
                'Icy-MetaData': '1'
            }
        }, (upstreamRes) => {
            if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && upstreamRes.headers.location) {
                return pipeRadiojar(upstreamRes.headers.location);
            }

            if (upstreamRes.statusCode !== 200) {
                res.writeHead(upstreamRes.statusCode);
                res.end();
                return;
            }

            res.writeHead(200, {
                'Content-Type': 'audio/mpeg',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*',
                'Connection': 'keep-alive',
                'icy-name': streamConfig.name,
                'icy-description': 'Reservatet.fm - ' + streamConfig.name,
                'icy-pub': '1',
                'icy-br': '256'
            });

            upstreamRes.pipe(res);

            req.on('close', () => {
                upstreamRes.destroy();
            });
        });

        upstreamReq.on('error', (err) => {
            console.error('[Audio Proxy Error]:', err.message);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
        });
    }

    pipeRadiojar(streamConfig.url);
});

server.listen(8082, '127.0.0.1', () => {
    console.log('Audio MP3 Proxy listening on 127.0.0.1:8082');
});
