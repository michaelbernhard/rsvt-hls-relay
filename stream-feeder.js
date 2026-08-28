const http = require('http');
const https = require('https');

function feedStream(sourceUrl, targetMount, streamName) {
    console.log(`[Feeder - ${streamName}] Starting ingest from ${sourceUrl}...`);

    function connect() {
        console.log(`[Feeder - ${streamName}] Connecting to source: ${sourceUrl}`);
        
        const sourceReq = (sourceUrl.startsWith('https:') ? https : http).get(sourceUrl, {
            headers: {
                'User-Agent': 'RSVT-Icecast-Ingest/2.0'
            }
        }, (sourceRes) => {
            if (sourceRes.statusCode >= 300 && sourceRes.statusCode < 400 && sourceRes.headers.location) {
                console.log(`[Feeder - ${streamName}] Following redirect to: ${sourceRes.headers.location}`);
                return feedStream(sourceRes.headers.location, targetMount, streamName);
            }

            if (sourceRes.statusCode !== 200) {
                console.error(`[Feeder - ${streamName}] Source returned status ${sourceRes.statusCode}. Retrying in 1s...`);
                setTimeout(connect, 1000);
                return;
            }

            console.log(`[Feeder - ${streamName}] Source audio connected! Pushing permanently to Icecast ${targetMount}...`);

            // Connect to local Icecast via SOURCE method
            const icecastReq = http.request({
                hostname: '127.0.0.1',
                port: 8080,
                path: targetMount,
                method: 'SOURCE',
                auth: 'source:rsvt_source_secret_2026',
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'ice-name': streamName,
                    'ice-public': '1',
                    'ice-genre': 'Eclectic',
                    'ice-bitrate': '256',
                    'ice-audio-info': 'ice-samplerate=44100;ice-bitrate=256;ice-channels=2'
                }
            });

            icecastReq.on('error', (err) => {
                console.error(`[Feeder - ${streamName}] Icecast push error:`, err.message);
                sourceRes.destroy();
                setTimeout(connect, 1000);
            });

            sourceRes.pipe(icecastReq);

            sourceRes.on('end', () => {
                console.warn(`[Feeder - ${streamName}] Source stream ended. Reconnecting in 200ms...`);
                icecastReq.end();
                setTimeout(connect, 200);
            });

            sourceRes.on('error', (err) => {
                console.error(`[Feeder - ${streamName}] Source error:`, err.message);
                icecastReq.destroy();
                setTimeout(connect, 1000);
            });
        });

        sourceReq.on('error', (err) => {
            console.error(`[Feeder - ${streamName}] Connection error:`, err.message);
            setTimeout(connect, 1000);
        });
    }

    connect();
}

// Wait 2 seconds for Icecast to start, then start feeders
setTimeout(() => {
    feedStream('http://stream.radiojar.com/c1wchedg76bwv', '/live.mp3', 'Reservatet.fm LIVE');
    feedStream('http://stream.radiojar.com/4hge3m401bpwv', '/bloedeboelger.mp3', 'Bløde Bølger');
}, 2000);
