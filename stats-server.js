const http = require('http');
const https = require('https');

// In-memory stats tracker
const activeSessions = new Map(); // ip -> { lastSeen, userAgent, requests }
let peakListeners = 0;
let totalRequests = 0;
const startTime = Date.now();

let currentTrack = {
    artist: 'Reservatet.fm',
    title: 'LIVE',
    startedAt: new Date().toISOString()
};

const ICY_META_INT = 16000;
const connectedClients = new Set();
let pendingMetadataPacket = null;

function updateMetadataPacket() {
    const metaString = `StreamTitle='${currentTrack.artist} - ${currentTrack.title}';`;
    const metaBuffer = Buffer.from(metaString, 'utf8');
    const numBlocks = Math.ceil(metaBuffer.length / 16);
    const totalLength = numBlocks * 16;
    
    const packet = Buffer.alloc(1 + totalLength);
    packet[0] = numBlocks;
    metaBuffer.copy(packet, 1);
    pendingMetadataPacket = packet;
}

updateMetadataPacket();

// Poll Radiojar API every 3 seconds for live song and artist
function pollRadiojar() {
    https.get('https://www.radiojar.com/api/stations/c1wchedg76bwv/now_playing/', (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(raw);
                const artist = (data.artist || '').trim();
                const title = (data.title || '').trim();
                if (title && (title !== currentTrack.title || artist !== currentTrack.artist)) {
                    console.log(`[NowPlaying Updated] ${artist} - ${title}`);
                    currentTrack = {
                        artist: artist || 'Reservatet.fm',
                        title: title,
                        startedAt: new Date().toISOString()
                    };
                    updateMetadataPacket();
                }
            } catch (e) {}
        });
    }).on('error', () => {});
}

setInterval(pollRadiojar, 3000);
pollRadiojar();

// ------------------------------------------------------------------
// Upstream Audio Ingest with Instant Reconnect & Zero-Drop Broadcast
// ------------------------------------------------------------------
let isConnecting = false;

function connectUpstream(url = 'http://stream.radiojar.com/c1wchedg76bwv') {
    if (isConnecting && url === 'http://stream.radiojar.com/c1wchedg76bwv') return;
    isConnecting = true;
    
    const req = http.get(url, {
        headers: {
            'User-Agent': 'RSVT-Relay-Broadcaster/4.0'
        },
        timeout: 10000
    }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            isConnecting = false;
            return connectUpstream(res.headers.location);
        }

        if (res.statusCode !== 200) {
            console.error(`[Upstream] Status ${res.statusCode}. Reconnecting in 500ms...`);
            isConnecting = false;
            setTimeout(() => connectUpstream(), 500);
            return;
        }

        isConnecting = false;
        console.log('[Upstream] Audio stream connected successfully! Broadcasting live chunks.');

        res.on('data', (chunk) => {
            for (const client of connectedClients) {
                try {
                    if (client.wantsIcy) {
                        sendIcyChunk(client, chunk);
                    } else {
                        client.res.write(chunk);
                    }
                } catch (e) {
                    connectedClients.delete(client);
                }
            }
        });

        res.on('end', () => {
            console.warn('[Upstream] Stream ended by Radiojar. Reconnecting instantly (0ms)...');
            connectUpstream();
        });
    });

    req.on('error', (err) => {
        console.error('[Upstream] Socket error:', err.message);
        isConnecting = false;
        setTimeout(() => connectUpstream(), 500);
    });

    req.on('timeout', () => {
        console.warn('[Upstream] Request timeout. Reconnecting...');
        req.destroy();
        isConnecting = false;
        connectUpstream();
    });
}

connectUpstream();

function sendIcyChunk(client, chunk) {
    let offset = 0;
    while (offset < chunk.length) {
        const bytesUntilMeta = ICY_META_INT - client.byteCount;
        const bytesToWrite = Math.min(bytesUntilMeta, chunk.length - offset);
        
        client.res.write(chunk.slice(offset, offset + bytesToWrite));
        client.byteCount += bytesToWrite;
        offset += bytesToWrite;

        if (client.byteCount === ICY_META_INT) {
            if (client.lastSentTitle !== currentTrack.title || client.needsInitialMeta) {
                client.res.write(pendingMetadataPacket);
                client.lastSentTitle = currentTrack.title;
                client.needsInitialMeta = false;
            } else {
                client.res.write(Buffer.from([0])); // 0 length = no change
            }
            client.byteCount = 0;
        }
    }
}

// Clean up inactive listeners every 5 seconds (25s timeout)
setInterval(() => {
    const now = Date.now();
    const WINDOW_MS = 25000;
    
    for (const [ip, data] of activeSessions.entries()) {
        if (now - data.lastSeen > WINDOW_MS) {
            activeSessions.delete(ip);
        }
    }
    
    if (activeSessions.size > peakListeners) {
        peakListeners = activeSessions.size;
    }
}, 5000);

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // Live ICY Audio Stream for Sonos (Instant In-Band Song Title Updates)
    if (url.pathname === '/stream.mp3' || url.pathname === '/live.mp3') {
        const ipHeader = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
        const clientIp = ipHeader.split(',')[0].trim();
        const userAgent = req.headers['user-agent'] || 'Sonos / MP3 Player';
        const wantsIcy = req.headers['icy-metadata'] === '1';

        totalRequests++;
        const now = Date.now();
        const current = activeSessions.get(clientIp) || { firstSeen: now, requests: 0 };
        current.lastSeen = now;
        current.userAgent = userAgent;
        current.requests++;
        activeSessions.set(clientIp, current);

        const headers = {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'close',
            'Access-Control-Allow-Origin': '*',
            'icy-notice1': 'Reservatet.fm Live Stream',
            'icy-name': 'Reservatet.fm LIVE',
            'icy-genre': 'Eclectic',
            'icy-pub': '1',
            'icy-br': '256'
        };

        if (wantsIcy) {
            headers['icy-metaint'] = ICY_META_INT.toString();
        }

        res.writeHead(200, headers);

        const client = {
            res,
            wantsIcy,
            byteCount: 0,
            lastSentTitle: '',
            needsInitialMeta: true
        };

        connectedClients.add(client);

        req.on('close', () => {
            connectedClients.delete(client);
        });

        return;
    }

    // Internal tracker ping from Nginx mirror
    if (url.pathname === '/internal/log') {
        const ipHeader = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
        const clientIp = ipHeader.split(',')[0].trim();
        const userAgent = req.headers['user-agent'] || 'Sonos / Player';
        const now = Date.now();

        totalRequests++;
        const current = activeSessions.get(clientIp) || { firstSeen: now, requests: 0 };
        current.lastSeen = now;
        current.userAgent = userAgent;
        current.requests++;
        activeSessions.set(clientIp, current);

        if (activeSessions.size > peakListeners) {
            peakListeners = activeSessions.size;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    // Public stats endpoint (JSON)
    if (url.pathname === '/stats' || url.pathname === '/stats.json' || url.pathname === '/listeners') {
        const now = Date.now();
        const WINDOW_MS = 25000;
        
        const activeList = [];
        for (const [ip, data] of activeSessions.entries()) {
            if (now - data.lastSeen <= WINDOW_MS) {
                const maskedIp = ip.includes('.') ? ip.replace(/\.\d+$/, '.xxx') : ip.replace(/:[^:]+$/, ':xxxx');
                activeList.push({
                    client: maskedIp,
                    seconds_ago: Math.round((now - data.lastSeen) / 1000),
                    user_agent: data.userAgent,
                    stream: 'Reservatet.fm LIVE'
                });
            }
        }

        const stats = {
            current_listeners: activeList.length,
            peak_listeners: peakListeners,
            total_requests: totalRequests,
            uptime_seconds: Math.round((now - startTime) / 1000),
            now_playing: currentTrack,
            listeners: activeList,
            timestamp: new Date().toISOString()
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats, null, 2));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(8081, '127.0.0.1', () => {
    console.log('Broadcaster and Stats server running on 127.0.0.1:8081');
});
