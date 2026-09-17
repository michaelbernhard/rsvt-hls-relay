process.on('uncaughtException', (err) => {
    console.error('[Audio Proxy UncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Audio Proxy UnhandledRejection]', reason);
});

const http = require('http');
const https = require('https');

// -------------------------------------------------------------
// Listener exclusion & security filters:
// 1. Keeps bots and datacenters out of listener statistics.
// 2. Blocks aggressive scanners (LeakIX, SiteRadar, etc.) immediately.
// -------------------------------------------------------------
const EXCLUDED_IPS = new Set([
    '109.175.213.2',   // autopo.st Cloud Logger (Kingsclere, UK)
]);

const EXCLUDED_UA_PATTERNS = [
    'cloud logger',    // autopo.st and similar stream monitors
    'autopo.st',
    'uptimerobot',
    'pingdom',
    'statuspage',
    'healthcheck',
    'curl',
    'python-requests',
    'crawler',
    'spider',
    'bot'
];

const BLOCKED_UA_PATTERNS = [
    'leakix',
    'l9scan',
    'siteradar',
    'shodan',
    'censys',
    'palo alto',
    'zgrab',
    'masscan',
    'nmap'
];

function isBlockedScanner(userAgent) {
    const ua = (userAgent || '').toLowerCase();
    return BLOCKED_UA_PATTERNS.some(p => ua.includes(p));
}

function isDatacenterIp(ip) {
    if (!ip) return false;
    const clean = ip.trim();
    // Google Cloud (34.x, 35.x)
    if (/^(34|35)\./.test(clean)) return true;
    // AWS (3.x, 18.x, 44.x, 52.x, 54.x, 63.x)
    if (/^(3|18|44|52|54|63)\./.test(clean)) return true;
    // Azure (20.x, 40.x, 51.x)
    if (/^(20|40|51)\./.test(clean)) return true;
    // DigitalOcean
    if (/^(143\.244|164\.90|159\.65|138\.68|167\.99|134\.209|178\.62|104\.248)\./.test(clean)) return true;
    // Cloudflare edge / worker / WARP
    if (/^(172\.64|104\.(1[6-9]|2[0-9]|3[0-1]|164)|141\.101)\./.test(clean)) return true;
    // Hurricane Electric / Shadowserver
    if (/^65\.49\./.test(clean)) return true;
    // Akamai / Linode cloud
    if (/^172\.232\./.test(clean)) return true;
    // Layer7 / M247 server networks
    if (/^91\.239\./.test(clean)) return true;
    return false;
}

function isExcludedListener(ip, userAgent) {
    if (EXCLUDED_IPS.has(ip)) return true;
    if (isDatacenterIp(ip)) return true;
    const ua = (userAgent || '').toLowerCase().trim();
    if (ua === 'mozilla/5.0') return true;
    return EXCLUDED_UA_PATTERNS.some(p => ua.includes(p));
}

function isBotOrScript(ip, userAgent) {
    if (isDatacenterIp(ip)) return true;
    const ua = (userAgent || '').toLowerCase().trim();
    if (!ua || ua === 'mozilla/5.0') return true;
    if (ua.includes('sonos')) return false;

    // Automation / scraping tools
    const botKeywords = [
        'curl', 'wget', 'python', 'headless', 'selenium', 'puppeteer', 'playwright',
        'phantomjs', 'zgrab', 'masscan', 'nmap', 'postman', 'insomnia', 'httpclient',
        'restsharp', 'winhttp', 'go-http-client', 'fasthttp', 'scrapy', 'bot', 'spider', 'crawler',
        'leakix', 'l9scan', 'siteradar', 'shodan', 'censys', 'shadowserver', 'autopo.st', 'cloud logger'
    ];
    if (botKeywords.some(k => ua.includes(k))) return true;

    // Ancient Firefox (< 100) or Chrome (< 100)
    const ffMatch = ua.match(/(?:firefox|rv:)\/??\s*(\d+)/);
    if (ffMatch && parseInt(ffMatch[1], 10) > 0 && parseInt(ffMatch[1], 10) < 100) return true;

    if (ua.includes('chrome/') && !ua.includes('smart-tv') && !ua.includes('tizen') && !ua.includes('webos')) {
        const crMatch = ua.match(/chrome\/(\d+)/);
        if (crMatch && parseInt(crMatch[1], 10) > 0 && parseInt(crMatch[1], 10) < 100) return true;
    }

    return false;
}

// Session lifetimes:
// - Real hardware devices (Sonos): Unlimited / 24 hours
// - Legitimate web players and mobile apps: Up to 12 hours
// - Suspected bots, scrapers and datacenter scripts: 15 minutes max!
const BOT_SESSION_MS = 15 * 60 * 1000;            // 15 min for bots
const STANDARD_SESSION_MS = 12 * 60 * 60 * 1000;  // 12 hours for real listeners
const SONOS_SESSION_MS = 24 * 60 * 60 * 1000;     // 24 hours for Sonos

// Persistent keep-alive agent for non-blocking dashboard telemetry
const heartbeatAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 5,
    timeout: 5000
});

// Configuration for live stream channels
const CHANNELS = {
    '/live.mp3': {
        name: 'Reservatet.fm LIVE',
        icyName: 'Reservatet.fm LIVE',
        icecastPath: '/live.mp3',
        bitrate: 320,
        sampleRate: 48000,
        clients: new Set()
    },
    '/sonos.mp3': {
        name: 'Reservatet.fm LIVE (Sonos)',
        icyName: 'Reservatet.fm LIVE',
        icecastPath: '/sonos.mp3',
        bitrate: 320,
        sampleRate: 48000,
        clients: new Set()
    },
    '/bloede.mp3': {
        name: 'Bløde Bølger',
        icyName: 'Bloede Boelger',
        icecastPath: '/bloede.mp3',
        bitrate: 128,
        sampleRate: 44100,
        clients: new Set()
    }
};

// Aliases
const ALIASES = {
    '/': '/live.mp3',
    '/stream.mp3': '/live.mp3',
    '/live-sonos.mp3': '/sonos.mp3',
    '/bloedeboelger.mp3': '/bloede.mp3'
};

// -------------------------------------------------------------
// Client Management & Heartbeat Tracking
// -------------------------------------------------------------
function removeClient(channelKey, clientObj) {
    const channel = CHANNELS[channelKey];
    if (channel && channel.clients.has(clientObj)) {
        channel.clients.delete(clientObj);
        const sessionSecs = Math.round((Date.now() - (clientObj.connectedAt || Date.now())) / 1000);
        console.log(`[Client Disconnect - ${clientObj.streamName}] IP: ${clientObj.ip}, session: ${sessionSecs}s, active clients: ${channel.clients.size}`);
    }
}

// -------------------------------------------------------------
// Periodic Heartbeat to PostgreSQL via Dashboard API (every 25s)
// -------------------------------------------------------------
function sendHeartbeat(clientIp, userAgent, streamName) {
    // Skip monitoring bots and audio loggers — they are not real listeners
    if (isExcludedListener(clientIp, userAgent)) return;
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

function notifyDisconnect(clientIp, streamName) {
    if (isExcludedListener(clientIp)) return;
    try {
        const payload = JSON.stringify({
            client: clientIp,
            stream: streamName,
            event: 'disconnect'
        });
        const req = https.request('https://reservatet.fm/api/dashboard/hls', {
            method: 'POST',
            agent: heartbeatAgent,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 3000
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

// -------------------------------------------------------------
// HTTP Streaming Server for Sonos, Web & Apps
// Proxies directly from local Icecast instance (127.0.0.1:8000)
// providing full 256KB burst on connect, rock-solid C-level
// broadcast pacing, zero packet loss, and zero timer drift.
// -------------------------------------------------------------
const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const resolvedPath = ALIASES[path] || path;
    // Health check endpoint
    if (path === '/health' || path === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK\n');
        return;
    }

    // Nginx async mirror endpoint for listener connection telemetry (100% out-of-band)
    if (path.startsWith('/internal/connect')) {
        const clientIp = (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const rawUa = (req.headers['x-user-agent'] || req.headers['user-agent'] || '').trim();

        // Drop automated port scanners / probes with missing or dummy user agent
        if (!rawUa || rawUa.toLowerCase() === 'mozilla/5.0') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK\n');
            return;
        }

        const streamUri = req.headers['x-stream-uri'] || req.url;
        const isSonos = (streamUri && streamUri.includes('sonos')) || rawUa.toLowerCase().includes('sonos');
        const streamName = (streamUri && streamUri.includes('bloede')) ? 'Bløde Bølger' : (isSonos ? 'Reservatet.fm LIVE (Sonos)' : 'Reservatet.fm LIVE');

        if (!isExcludedListener(clientIp, rawUa)) {
            sendHeartbeat(clientIp, rawUa, streamName);
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK\n');
        return;
    }

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

    if (req.method === 'HEAD') {
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': '*',
            'Connection': 'keep-alive'
        });
        res.end();
        return;
    }

    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
    }

    // Client connection metadata
    const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const userAgent = req.headers['user-agent'] || 'Sonos / Audio Player';

    // Block aggressive scanner bots immediately without serving audio
    if (isBlockedScanner(userAgent)) {
        console.log(`[Security] Blocked scanner UA "${userAgent}" from IP ${clientIp}`);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden\n');
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
    const isMonitor = isExcludedListener(clientIp, userAgent);
    console.log(`[${isMonitor ? 'Monitor' : 'Client'} Connect - ${streamName}] IP: ${clientIp}, UA: ${userAgent}, active clients: ${channel.clients.size}${isMonitor ? ' [excluded from stats]' : ''}`);

    // Only register listener in database if connection stays open for at least 15 seconds
    // This completely ignores 1-second port scanners and brief network probes
    const initialHeartbeatTimer = setTimeout(() => {
        if (channel.clients.has(clientObj)) {
            sendHeartbeat(clientIp, userAgent, streamName);
        }
    }, 15000);

    // Proxy audio stream directly from local Icecast instance
    const icecastReq = http.request({
        hostname: '127.0.0.1',
        port: 8000,
        path: channel.icecastPath,
        method: 'GET',
        headers: {
            'User-Agent': userAgent,
            'X-Forwarded-For': clientIp
        }
    }, (icecastRes) => {
        // Disable chunked transfer encoding to deliver pure continuous binary MP3
        res.useChunkedEncodingByDefault = false;

        res.writeHead(icecastRes.statusCode || 200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Access-Control-Allow-Origin': '*',
            'Connection': 'close',
            'X-Accel-Buffering': 'no',
            'icy-name': channel.icyName || channel.name,
            'icy-description': 'Reservatet.fm - ' + (channel.icyName || channel.name),
            'icy-pub': '1',
            'icy-br': String(channel.bitrate || 320),
            'icy-sr': String(channel.sampleRate || 48000),
            'icy-samplerate': String(channel.sampleRate || 48000)
        });

        icecastRes.pipe(res);
    });

    icecastReq.on('error', (err) => {
        console.error(`[Icecast Proxy Error - ${streamName}]`, err.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end();
        removeClient(resolvedPath, clientObj);
    });

    icecastReq.end();

    let cleanedUp = false;
    let maxSessionTimer = null;

    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(initialHeartbeatTimer);
        if (maxSessionTimer) clearTimeout(maxSessionTimer);
        icecastReq.destroy();
        removeClient(resolvedPath, clientObj);
        notifyDisconnect(clientIp, streamName);
    };

    const isBot = isBotOrScript(clientIp, userAgent);
    const sessionLimitMs = isSonos ? SONOS_SESSION_MS : (isBot ? BOT_SESSION_MS : STANDARD_SESSION_MS);

    // Auto-disconnect: bots and scraper sockets get closed after 15 minutes, while Sonos and real listeners can listen all day
    maxSessionTimer = setTimeout(() => {
        console.log(`[Session Limit ${isBot ? '15m (Bot/Script)' : (isSonos ? '24h (Sonos)' : '12h')} - ${streamName}] Closing session for IP: ${clientIp}`);
        try {
            res.end();
        } catch (e) {}
        cleanup();
    }, sessionLimitMs);

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
});

// Periodic safety check to prune zombie bots (> 15m) and excessively long connections
setInterval(() => {
    const now = Date.now();
    for (const [channelKey, channel] of Object.entries(CHANNELS)) {
        for (const clientObj of channel.clients) {
            const isSonos = (clientObj.streamName || '').includes('Sonos') || (clientObj.userAgent || '').toLowerCase().includes('sonos');
            const isBot = isBotOrScript(clientObj.ip, clientObj.userAgent);
            const limit = isSonos ? SONOS_SESSION_MS : (isBot ? BOT_SESSION_MS : STANDARD_SESSION_MS);
            if (now - (clientObj.connectedAt || now) > limit) {
                console.log(`[Safety Prune] Client ${clientObj.ip} (${isBot ? 'Bot/Script > 15m' : 'Standard > 12h'}) terminated on ${channelKey}`);
                try {
                    clientObj.res.end();
                } catch (e) {}
                channel.clients.delete(clientObj);
                notifyDisconnect(clientObj.ip, clientObj.streamName || channel.name);
            }
        }
    }
}, 60 * 1000);

// Start server on port 8082
const PORT = 8082;
server.listen(PORT, '127.0.0.1', () => {
    console.log(`[RSVT Broadcast Hub] Audio MP3 Proxy listening permanently on 127.0.0.1:${PORT}`);
});

