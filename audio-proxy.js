process.on('uncaughtException', (err) => {
    console.error('[Audio Proxy UncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Audio Proxy UnhandledRejection]', reason);
});

const http = require('http');
const https = require('https');

// Persistent keep-alive agent for non-blocking dashboard telemetry
const heartbeatAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 5,
    timeout: 5000
});

// High-performance circular byte buffer for continuous jitter-free streaming
class AudioQueue {
    constructor() {
        this.chunks = [];
        this.totalBytes = 0;
    }
    push(buf) {
        this.chunks.push(buf);
        this.totalBytes += buf.length;
    }
    pull(bytesNeeded) {
        if (this.totalBytes === 0) return null;
        if (this.totalBytes <= bytesNeeded) {
            const out = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
            this.chunks = [];
            this.totalBytes = 0;
            return out;
        }
        const collected = [];
        let collectedBytes = 0;
        while (this.chunks.length > 0 && collectedBytes < bytesNeeded) {
            const first = this.chunks[0];
            const remaining = bytesNeeded - collectedBytes;
            if (first.length <= remaining) {
                collected.push(this.chunks.shift());
                collectedBytes += first.length;
            } else {
                collected.push(first.subarray(0, remaining));
                this.chunks[0] = first.subarray(remaining);
                collectedBytes += remaining;
                break;
            }
        }
        this.totalBytes -= collectedBytes;
        return collected.length === 1 ? collected[0] : Buffer.concat(collected);
    }
    peekAll() {
        if (this.totalBytes === 0) return Buffer.alloc(0);
        return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    }
    trim(maxBytes) {
        while (this.totalBytes > maxBytes && this.chunks.length > 0) {
            const removed = this.chunks.shift();
            this.totalBytes -= removed.length;
        }
    }
}

// Configuration for live stream channels with Server-Side Jitter Queue
const CHANNELS = {
    '/live.mp3': {
        name: 'Reservatet.fm LIVE',
        icyName: 'Reservatet.fm LIVE',
        sourceUrl: 'https://cdn01.radio.cloud/RES-COP-CINURAUDIO01',
        bitrate: 320,
        sampleRate: 48000,
        clients: new Set(),
        queue: new AudioQueue(),
        maxQueueBytes: 480 * 1024, // 480 KB (~12s continuous cushion)
        targetQueueBytes: 320 * 1024, // 320 KB (~8s nominal buffer depth)
        burstBytes: 160 * 1024, // 160 KB (~4s instant connect fill)
        isConnected: false,
        reconnectTimer: null,
        isFirstChunkAfterConnect: true
    },
    '/bloede.mp3': {
        name: 'Bløde Bølger',
        icyName: 'Bloede Boelger',
        sourceUrl: 'http://stream.radiojar.com/4hge3m401bpwv',
        bitrate: 128,
        sampleRate: 44100,
        clients: new Set(),
        queue: new AudioQueue(),
        maxQueueBytes: 200 * 1024, // 200 KB (~12.5s continuous cushion)
        targetQueueBytes: 128 * 1024, // 128 KB (~8s nominal buffer depth)
        burstBytes: 64 * 1024, // 64 KB (~4s instant connect fill)
        isConnected: false,
        reconnectTimer: null,
        isFirstChunkAfterConnect: true
    }
};

// Aliases - All live endpoints (/live.mp3, /sonos.mp3, /) share the single stable Radio.cloud ingest
const ALIASES = {
    '/': '/live.mp3',
    '/stream.mp3': '/live.mp3',
    '/sonos.mp3': '/live.mp3',
    '/live-sonos.mp3': '/live.mp3',
    '/bloedeboelger.mp3': '/bloede.mp3'
};

// -------------------------------------------------------------
// Central Stream Ingest Worker with Auto-Reconnect & Single-Stream Lock
// -------------------------------------------------------------
function startIngest(channelKey, targetUrl = null, redirectDepth = 0) {
    const channel = CHANNELS[channelKey];
    if (!channel) return;

    if (redirectDepth === 0) {
        if (channel.reconnectTimer) {
            clearTimeout(channel.reconnectTimer);
            channel.reconnectTimer = null;
        }
        // Increment generation ID to instantly invalidate all previous/zombie connections
        channel.generationId = (channel.generationId || 0) + 1;
        if (channel.activeReq) {
            try { channel.activeReq.destroy(); } catch (e) {}
            channel.activeReq = null;
        }
        if (channel.activeRes) {
            try { channel.activeRes.destroy(); } catch (e) {}
            channel.activeRes = null;
        }
    }

    const currentGen = channel.generationId;
    const fetchUrl = targetUrl || channel.sourceUrl;
    const client = fetchUrl.startsWith('https:') ? https : http;

    console.log(`[Ingest - ${channel.name} (Gen ${currentGen})] Connecting to: ${fetchUrl}`);

    const req = client.get(fetchUrl, {
        headers: {
            'User-Agent': 'RSVT-Broadcast-Ingest/3.0',
            'Connection': 'keep-alive'
        },
        timeout: 8000
    }, (res) => {
        if (channel.generationId !== currentGen) {
            res.destroy();
            req.destroy();
            return;
        }

        // Follow redirects cleanly WITHOUT leaving zombie connections or overwriting sourceUrl
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectDepth < 5) {
            console.log(`[Ingest - ${channel.name}] Redirect (${res.statusCode}) -> ${res.headers.location}`);
            res.destroy();
            req.destroy();
            return startIngest(channelKey, res.headers.location, redirectDepth + 1);
        }

        if (res.statusCode !== 200) {
            console.error(`[Ingest - ${channel.name}] Upstream returned status ${res.statusCode}. Reconnecting in 1s...`);
            res.destroy();
            req.destroy();
            scheduleReconnect(channelKey, 1000);
            return;
        }

        channel.isFirstChunkAfterConnect = true;
        channel.activeReq = req;
        channel.activeRes = res;
        channel.isConnected = true;
        console.log(`[Ingest - ${channel.name} (Gen ${currentGen})] Audio connected! Broadcasting live to ${channel.clients.size} clients.`);

        res.on('data', (chunk) => {
            if (channel.generationId !== currentGen) return;

            // Ensure first chunk after upstream reconnect aligns strictly to MP3 frame boundary
            if (channel.isFirstChunkAfterConnect) {
                channel.isFirstChunkAfterConnect = false;
                const offset = findMp3FrameStart(chunk);
                if (offset > 0) {
                    chunk = chunk.subarray(offset);
                }
            }

            // Append to Server-Side Jitter Queue
            channel.queue.push(chunk);
            if (channel.queue.totalBytes > channel.maxQueueBytes) {
                channel.queue.trim(channel.maxQueueBytes);
            }
        });

        res.on('end', () => {
            if (channel.generationId !== currentGen) return;
            console.warn(`[Ingest - ${channel.name}] Upstream stream ended. Auto-reconnecting in 10ms...`);
            channel.isConnected = false;
            channel.activeRes = null;
            scheduleReconnect(channelKey, 10);
        });

        res.on('error', (err) => {
            if (channel.generationId !== currentGen) return;
            console.error(`[Ingest - ${channel.name}] Upstream stream error: ${err.message}. Reconnecting in 50ms...`);
            channel.isConnected = false;
            channel.activeRes = null;
            res.destroy();
            scheduleReconnect(channelKey, 50);
        });
    });

    req.on('timeout', () => {
        if (channel.generationId !== currentGen) return;
        console.error(`[Ingest - ${channel.name}] Connection timeout. Retrying in 500ms...`);
        req.destroy();
        channel.isConnected = false;
        channel.activeReq = null;
        scheduleReconnect(channelKey, 500);
    });

    req.on('error', (err) => {
        if (channel.generationId !== currentGen) return;
        console.error(`[Ingest - ${channel.name}] Request error: ${err.message}. Retrying in 1s...`);
        channel.isConnected = false;
        channel.activeReq = null;
        scheduleReconnect(channelKey, 1000);
    });
}

function scheduleReconnect(channelKey, delayMs) {
    const channel = CHANNELS[channelKey];
    if (!channel) return;
    if (channel.reconnectTimer) return;

    channel.reconnectTimer = setTimeout(() => {
        channel.reconnectTimer = null;
        startIngest(channelKey);
    }, delayMs);
}

// -------------------------------------------------------------
// Client Management & Heartbeat Tracking
// -------------------------------------------------------------
function removeClient(channelKey, clientObj) {
    const channel = CHANNELS[channelKey];
    if (channel && channel.clients.has(clientObj)) {
        channel.clients.delete(clientObj);
        const name = (clientObj.path && clientObj.path.includes('sonos')) ? 'Reservatet.fm LIVE (Sonos)' : channel.name;
        console.log(`[Client Disconnect - ${name}] IP: ${clientObj.ip}, active clients: ${channel.clients.size}`);
    }
}

// Start ingest for all channels immediately
for (const key of Object.keys(CHANNELS)) {
    startIngest(key);
}

// -------------------------------------------------------------
// Continuous Real-Time Audio Pacer (100ms ticks, 10 ticks/sec)
// Delivers steady, gapless broadcast stream to all connected clients
// Absorbs upstream song transition gaps and reconnect hiccups seamlessly
// -------------------------------------------------------------
const TICK_MS = 100;
setInterval(() => {
    for (const [channelKey, channel] of Object.entries(CHANNELS)) {
        if (channel.clients.size === 0) {
            // Trim idle buffer to nominal target so new listeners get an instant burst
            if (channel.queue.totalBytes > channel.targetQueueBytes) {
                channel.queue.trim(channel.targetQueueBytes);
            }
            continue;
        }

        const bytesPerSec = (channel.bitrate * 1000) / 8;
        let bytesToSend = Math.round(bytesPerSec * (TICK_MS / 1000));

        // Smooth rate pacing: if queue is overflowing, drain slightly faster (+5%)
        if (channel.queue.totalBytes > channel.targetQueueBytes + 40000) {
            bytesToSend = Math.round(bytesToSend * 1.05);
        }

        const chunk = channel.queue.pull(bytesToSend);
        if (!chunk || chunk.length === 0) continue;

        for (const clientObj of channel.clients) {
            try {
                clientObj.res.write(chunk);
            } catch (err) {
                removeClient(channelKey, clientObj);
            }
        }
    }
}, TICK_MS);

// -------------------------------------------------------------
// Helper to locate first clean MP3 frame header
// -------------------------------------------------------------
function findMp3FrameStart(buf) {
    for (let i = 0; i < buf.length - 3; i++) {
        if (buf[i] === 0xFF && (buf[i + 1] & 0xE0) === 0xE0) {
            const version = (buf[i + 1] >> 3) & 0x03;
            const layer = (buf[i + 1] >> 1) & 0x03;
            const bitrateIdx = (buf[i + 2] >> 4) & 0x0F;
            const srIdx = (buf[i + 2] >> 2) & 0x03;
            if (version !== 1 && layer === 1 && bitrateIdx > 0 && bitrateIdx < 15 && srIdx < 3) {
                return i;
            }
        }
    }
    return 0;
}

// -------------------------------------------------------------
// HTTP Streaming Server for Sonos, Web & Apps
// -------------------------------------------------------------
const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const resolvedPath = ALIASES[path] || path;
    const channel = CHANNELS[resolvedPath];

    if (!channel) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*'
        });
        res.end();
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
    }

    // Client connection metadata
    const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const userAgent = req.headers['user-agent'] || 'Sonos / Audio Player';
    
    // Set standard Icecast / Broadcast HTTP headers
    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*',
        'Connection': 'keep-alive',
        'icy-name': channel.icyName || channel.name,
        'icy-description': 'Reservatet.fm - ' + (channel.icyName || channel.name),
        'icy-pub': '1',
        'icy-br': String(channel.bitrate || 320),
        'icy-sr': String(channel.sampleRate || 48000),
        'icy-samplerate': String(channel.sampleRate || 48000)
    });

    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    const isSonos = path.includes('sonos');
    const streamName = isSonos ? 'Reservatet.fm LIVE (Sonos)' : channel.name;

    const clientObj = {
        res,
        req,
        ip: clientIp,
        userAgent,
        connectedAt: Date.now(),
        path: path,
        streamName: streamName
    };

    channel.clients.add(clientObj);
    console.log(`[Client Connect - ${streamName}] IP: ${clientIp}, UA: ${userAgent}, active clients: ${channel.clients.size}`);

    // Send immediate audio burst from jitter queue, strictly aligned to first MP3 frame sync
    if (channel.queue.totalBytes > 0) {
        const fullBuf = channel.queue.peekAll();
        const sliceLen = Math.min(fullBuf.length, channel.burstBytes || 160 * 1024);
        const burstBuf = fullBuf.subarray(0, sliceLen);
        const offset = findMp3FrameStart(burstBuf);
        try {
            res.write(burstBuf.subarray(offset));
        } catch (e) {
            removeClient(resolvedPath, clientObj);
            return;
        }
    }

    // Ping dashboard API immediately upon connection
    sendHeartbeat(clientIp, userAgent, streamName);

    // Clean up on disconnect
    req.on('close', () => removeClient(resolvedPath, clientObj));
    res.on('close', () => removeClient(resolvedPath, clientObj));
    res.on('error', () => removeClient(resolvedPath, clientObj));
});

// -------------------------------------------------------------
// Periodic Heartbeat to PostgreSQL via Dashboard API (every 20s)
// -------------------------------------------------------------
function sendHeartbeat(clientIp, userAgent, streamName) {
    try {
        const payload = JSON.stringify({
            client: clientIp,
            userAgent: userAgent,
            stream: streamName
        });
        const req = https.request('https://reservatet.fm/api/dashboard/hls', {
            method: 'POST',
            agent: heartbeatAgent,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 4000
        }, (res) => {
            res.resume();
        });
        req.on('error', () => {});
        req.on('timeout', () => req.destroy());
        req.write(payload);
        req.end();
    } catch (e) {}
}

setInterval(() => {
    let delay = 0;
    for (const [channelKey, channel] of Object.entries(CHANNELS)) {
        for (const clientObj of channel.clients) {
            setTimeout(() => {
                if (channel.clients.has(clientObj)) {
                    sendHeartbeat(clientObj.ip, clientObj.userAgent, clientObj.streamName || channel.name);
                }
            }, delay);
            delay += 100; // 100ms between each client ping
        }
    }
}, 25000);

// Start server on port 8082
const PORT = 8082;
server.listen(PORT, '127.0.0.1', () => {
    console.log(`[RSVT Broadcast Hub] Audio MP3 Proxy listening permanently on 127.0.0.1:${PORT}`);
});
