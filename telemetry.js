/**
 * Reservatet.fm - Dedicated Listener Telemetry Daemon
 * 
 * 100% Out-Of-Band: Does NOT proxy audio!
 * Receives connection events asynchronously from Nginx (via ngx_http_mirror_module)
 * and monitors active TCP sockets via 'ss' to maintain accurate real-time stats.
 * If this process ever restarts or fails, AUDIO IS NEVER AFFECTED.
 */

const http = require('http');
const https = require('https');
const { exec } = require('child_process');

process.on('uncaughtException', (err) => console.error('[Telemetry UncaughtException]', err));
process.on('unhandledRejection', (reason) => console.error('[Telemetry UnhandledRejection]', reason));

// Bot and monitor exclusion filter
const EXCLUDED_IPS = new Set([
    '109.175.213.2', // autopo.st Cloud Logger
    '127.0.0.1',
    '::1'
]);

const EXCLUDED_UA_PATTERNS = [
    'cloud logger',
    'autopo.st',
    'uptimerobot',
    'pingdom',
    'statuspage',
    'healthcheck',
    'palo alto',
    'twitterbot',
    'grokbot',
    'meta-externalagent',
    'oai-searchbot',
    'perplexity',
    'applebot',
    'curl'
];

function isExcluded(ip, ua) {
    if (!ip || EXCLUDED_IPS.has(ip)) return true;
    const lower = (ua || '').toLowerCase();
    return EXCLUDED_UA_PATTERNS.some(p => lower.includes(p));
}

// In-memory active listeners tracker: ip -> { ip, userAgent, stream, connectedAt, lastSeen }
const activeListeners = new Map();

// Channel name resolver
function resolveStreamName(uri, ua) {
    const isSonos = (uri && uri.includes('sonos')) || (ua && ua.toLowerCase().includes('sonos'));
    if (uri && uri.includes('bloede')) return 'Bløde Bølger';
    if (isSonos) return 'Reservatet.fm LIVE (Sonos)';
    return 'Reservatet.fm LIVE';
}

// Persistent keep-alive agent for non-blocking telemetry POSTs
const heartbeatAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 5,
    timeout: 4000
});

function sendHeartbeat(clientIp, userAgent, streamName) {
    if (isExcluded(clientIp, userAgent)) return;
    try {
        const payload = JSON.stringify({
            client: clientIp,
            userAgent: userAgent || 'Sonos / Audio Player',
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

// HTTP Server for Nginx async mirror notifications
const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health' || req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK\n');
        return;
    }

    // Nginx mirror endpoint for new stream connections
    if (req.url.startsWith('/internal/connect')) {
        const clientIp = (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const userAgent = req.headers['x-user-agent'] || req.headers['user-agent'] || 'Sonos / Audio Player';
        const streamUri = req.headers['x-stream-uri'] || req.url;
        const streamName = resolveStreamName(streamUri, userAgent);

        if (!isExcluded(clientIp, userAgent)) {
            const now = Date.now();
            activeListeners.set(clientIp, {
                ip: clientIp,
                userAgent: userAgent,
                stream: streamName,
                connectedAt: now,
                lastSeen: now
            });

            console.log(`[Listener Connect - ${streamName}] IP: ${clientIp}, UA: ${userAgent}, active listeners: ${activeListeners.size}`);
            sendHeartbeat(clientIp, userAgent, streamName);
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK\n');
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
});

// Periodic TCP Socket Verifier & Heartbeat Loop (every 25 seconds)
// Verifies which IPs are actually still connected via active kernel sockets
setInterval(() => {
    exec("ss -tnpH '( sport = :443 or sport = :80 )'", (err, stdout) => {
        if (err || !stdout) return;

        const currentConnectedIps = new Set();
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 5 && parts[0] === 'ESTAB') {
                const peer = parts[4];
                const ip = peer.substring(0, peer.lastIndexOf(':'));
                if (ip && !EXCLUDED_IPS.has(ip)) {
                    currentConnectedIps.add(ip);
                }
            }
        }

        // Clean up listeners that are no longer connected
        for (const [ip, listener] of activeListeners.entries()) {
            if (!currentConnectedIps.has(ip)) {
                const sessionSecs = Math.round((Date.now() - listener.connectedAt) / 1000);
                activeListeners.delete(ip);
                console.log(`[Listener Disconnect - ${listener.stream}] IP: ${ip}, session: ${sessionSecs}s, remaining listeners: ${activeListeners.size}`);
            }
        }

        // Send heartbeats for all verified active listeners
        let delay = 0;
        for (const [ip, listener] of activeListeners.entries()) {
            setTimeout(() => {
                if (activeListeners.has(ip)) {
                    sendHeartbeat(listener.ip, listener.userAgent, listener.stream);
                }
            }, delay);
            delay += 100;
        }
    });
}, 25000);

const PORT = 8082;
server.listen(PORT, '127.0.0.1', () => {
    console.log(`[RSVT Telemetry Daemon] Listening for out-of-band telemetry events on 127.0.0.1:${PORT}`);
});
