import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { openDatabase, createRepository, SOS_STATUSES, TEAM_STATUSES } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || join(__dirname, '..', 'data', 'sos.db');
const STATIC_DIR = process.env.STATIC_DIR || join(__dirname, '..', '..', 'client', 'dist');
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || 'rescue-dev-key';

if (!process.env.DASHBOARD_KEY) {
    console.warn('[server] DASHBOARD_KEY not set, using the development key. Set it in production.');
}

const repo = createRepository(openDatabase(DB_FILE));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// ---------- helpers ----------

const requireRescuer = (req, res, next) => {
    if (req.get('x-dashboard-key') === DASHBOARD_KEY) return next();
    res.status(401).json({ error: 'Rescuer passcode required' });
};

const isString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validates one SOS message coming from a phone; returns an error string or null. */
function validateSos(m) {
    if (!m || typeof m !== 'object') return 'message must be an object';
    if (!isString(m.id, 100)) return 'id is required';
    if (!isString(m.text, 2000)) return 'text is required (max 2000 chars)';
    if (!isString(m.senderId, 100)) return 'senderId is required';
    if (!isNum(m.timestamp)) return 'timestamp must be a number';
    if (m.location != null) {
        const { latitude, longitude } = m.location;
        if (!isNum(latitude) || !isNum(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            return 'location is invalid';
        }
    }
    if (m.fallSeverity != null && !['light', 'moderate', 'severe', 'critical'].includes(m.fallSeverity)) {
        return 'fallSeverity is invalid';
    }
    return null;
}

// ---------- live updates (WebSocket) ----------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    // Rescuers get full records; victims' phones only get status changes for their own ids.
    socket.isRescuer = url.searchParams.get('key') === DASHBOARD_KEY;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.send(JSON.stringify({ type: 'hello', rescuer: socket.isRescuer }));
});

// Drop dead connections (phones losing signal) every 30s.
const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.isAlive) { socket.terminate(); continue; }
        socket.isAlive = false;
        socket.ping();
    }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

function broadcast(type, sos) {
    const full = JSON.stringify({ type, sos });
    const slim = JSON.stringify({
        type: 'status',
        sos: { id: sos.id, status: sos.status, teamName: sos.team?.name ?? null, updatedAt: sos.updatedAt },
    });
    for (const socket of wss.clients) {
        if (socket.readyState === socket.OPEN) socket.send(socket.isRescuer ? full : slim);
    }
}

function broadcastTeams() {
    const msg = JSON.stringify({ type: 'teams', teams: repo.listTeams() });
    for (const socket of wss.clients) {
        if (socket.readyState === socket.OPEN && socket.isRescuer) socket.send(msg);
    }
}

// ---------- public API (used by victims' phones) ----------

app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()), time: Date.now() });
});

/**
 * A phone uploads every SOS it holds: its own plus any it received over the
 * offline mesh. The phone with internet acts as a gateway for the others.
 */
app.post('/api/sos', (req, res) => {
    const { deviceId, messages } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 200) {
        return res.status(400).json({ error: 'messages must be a non-empty array (max 200)' });
    }
    for (const m of messages) {
        const err = validateSos(m);
        if (err) return res.status(400).json({ error: `${m?.id ?? 'message'}: ${err}` });
    }
    const { created, updated } = repo.ingest(messages, isString(deviceId, 100) ? deviceId : null);
    for (const sos of created) broadcast('sos:new', sos);
    for (const sos of updated) broadcast('sos:update', sos);
    res.status(201).json({
        accepted: messages.map(m => m.id),
        statuses: repo.publicStatus(messages.map(m => m.id)),
    });
});

app.get('/api/sos/status', (req, res) => {
    const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 200);
    res.json(repo.publicStatus(ids));
});

// ---------- rescuer API (dashboard, passcode protected) ----------

app.post('/api/auth/check', requireRescuer, (_req, res) => res.json({ ok: true }));

app.get('/api/sos', requireRescuer, (req, res) => {
    const status = req.query.status;
    if (status && !SOS_STATUSES.includes(status)) return res.status(400).json({ error: 'unknown status' });
    res.json(repo.listSos({ status }));
});

app.get('/api/sos/:id', requireRescuer, (req, res) => {
    const sos = repo.getSos(req.params.id);
    if (!sos) return res.status(404).json({ error: 'not found' });
    res.json({ ...sos, events: repo.events(sos.id) });
});

app.patch('/api/sos/:id', requireRescuer, (req, res) => {
    const { status, teamId, note } = req.body ?? {};
    if (status !== undefined && !SOS_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${SOS_STATUSES.join(', ')}` });
    }
    if (teamId !== undefined && teamId !== null && !Number.isInteger(teamId)) {
        return res.status(400).json({ error: 'teamId must be an integer or null' });
    }
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 1000)) {
        return res.status(400).json({ error: 'note must be a string (max 1000 chars)' });
    }
    const sos = repo.updateSos(req.params.id, { status, teamId, note });
    if (!sos) return res.status(404).json({ error: 'not found' });
    broadcast('sos:update', sos);
    if (teamId !== undefined || status !== undefined) broadcastTeams();
    res.json({ ...sos, events: repo.events(sos.id) });
});

app.get('/api/teams', requireRescuer, (_req, res) => res.json(repo.listTeams()));

app.post('/api/teams', requireRescuer, (req, res) => {
    const { name, contact } = req.body ?? {};
    if (!isString(name, 80)) return res.status(400).json({ error: 'name is required (max 80 chars)' });
    const team = repo.createTeam({ name, contact: typeof contact === 'string' ? contact.slice(0, 120) : null });
    broadcastTeams();
    res.status(201).json(team);
});

app.patch('/api/teams/:id', requireRescuer, (req, res) => {
    const { name, contact, status } = req.body ?? {};
    if (status !== undefined && !TEAM_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${TEAM_STATUSES.join(', ')}` });
    }
    const team = repo.updateTeam(Number(req.params.id), { name, contact, status });
    if (!team) return res.status(404).json({ error: 'not found' });
    broadcastTeams();
    res.json(team);
});

app.delete('/api/teams/:id', requireRescuer, (req, res) => {
    if (!repo.deleteTeam(Number(req.params.id))) return res.status(404).json({ error: 'not found' });
    broadcastTeams();
    res.status(204).end();
});

app.get('/api/stats', requireRescuer, (_req, res) => res.json(repo.stats()));

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// ---------- static files: the victim PWA and the rescuer dashboard ----------

if (existsSync(STATIC_DIR)) {
    app.use(express.static(STATIC_DIR, {
        setHeaders(res, path) {
            // The service worker must never be cached, or phones keep an old app forever.
            if (path.endsWith('sw.js') || path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        },
    }));
    app.get('/dashboard', (_req, res) => res.sendFile(join(STATIC_DIR, 'dashboard.html')));
    app.get('*', (_req, res) => res.sendFile(join(STATIC_DIR, 'index.html')));
} else {
    console.warn(`[server] ${STATIC_DIR} not found; run "npm run build" in client/ to serve the apps.`);
}

app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    console.error('[server]', err);
    res.status(500).json({ error: 'internal error' });
});

server.listen(PORT, HOST, () => {
    console.log(`[server] Disaster SOS backend listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        console.log(`[server] ${signal} received, shutting down`);
        wss.close();
        server.close(() => process.exit(0));
    });
}
