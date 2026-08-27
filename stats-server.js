const http = require('http');

// In-memory stats tracker
const activeSessions = new Map(); // ip -> { lastSeen, userAgent, requests }
let peakListeners = 0;
let totalRequests = 0;
const startTime = Date.now();

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
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // Internal tracker ping from Nginx mirror
    if (url.pathname === '/internal/log') {
        const ipHeader = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
        const clientIp = ipHeader.split(',')[0].trim();
        const userAgent = req.headers['user-agent'] || 'Sonos / HLS Player';
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
                    stream: 'Reservatet.fm LIVE (HLS)'
                });
            }
        }

        const stats = {
            current_listeners: activeList.length,
            peak_listeners: peakListeners,
            total_requests: totalRequests,
            uptime_seconds: Math.round((now - startTime) / 1000),
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
    console.log('Stats tracking server running on 127.0.0.1:8081');
});
