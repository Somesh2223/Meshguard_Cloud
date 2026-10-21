import type { SOSMessage, RescueStatusUpdate } from '../types/sos';
import { offlineStorage } from './OfflineStorage';
import { deviceId } from '../utils/deviceId';

// Same origin by default: the EC2 server hosts both this app and the API.
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const SYNC_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

export type CloudState = 'offline' | 'connecting' | 'connected';

/**
 * Bridges the offline mesh to the rescue server on AWS EC2.
 *
 * Whenever this phone has internet it uploads every SOS it holds that the server
 * hasn't stored yet: its own and those it received from other phones over the mesh.
 * It then listens on a WebSocket for rescue status changes and writes them back
 * to local storage so the victim sees "Team en route" even after a reload.
 */
export class CloudSyncService {
    private socket: WebSocket | null = null;
    private backoff = 1_000;
    private syncing = false;
    private resyncRequested = false;
    private started = false;
    private state: CloudState = 'offline';
    private updateListeners: ((m: SOSMessage) => void)[] = [];
    private stateListeners: ((s: CloudState) => void)[] = [];

    start() {
        if (this.started) return;
        this.started = true;
        window.addEventListener('online', () => { this.connect(); this.syncPending(); });
        window.addEventListener('offline', () => this.setState('offline'));
        setInterval(() => { this.syncPending(); this.refreshStatuses(); }, SYNC_INTERVAL_MS);
        this.connect();
        this.syncPending();
    }

    onMessageUpdated(cb: (m: SOSMessage) => void) { this.updateListeners.push(cb); }

    onStateChange(cb: (s: CloudState) => void) {
        this.stateListeners.push(cb);
        cb(this.state);
    }

    /** Uploads every unsynced, non-test message. Safe to call often. */
    async syncPending(): Promise<void> {
        if (!navigator.onLine) return;
        if (this.syncing) { this.resyncRequested = true; return; }
        this.syncing = true;
        try {
            const pending = (await offlineStorage.getAllMessages()).filter(m => !m.cloudSynced && !m.isTest);
            if (pending.length === 0) return;

            const res = await fetch(`${API_BASE}/api/sos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ deviceId, messages: pending.map(toWire) }),
            });
            if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
            const { statuses } = await res.json() as { statuses: RescueStatusUpdate[] };
            const byId = new Map(statuses.map(s => [s.id, s]));

            for (const m of pending) {
                await this.patchLocal(m.id, local => ({
                    ...local,
                    cloudSynced: true,
                    // Own messages become "sent"; relayed ones keep "received".
                    status: local.status === 'queued' ? 'sent' : local.status,
                    ...statusFields(byId.get(m.id)),
                }));
            }
            console.log(`[CloudSync] Uploaded ${pending.length} SOS message(s) to the rescue server`);
        } catch (err) {
            console.warn('[CloudSync] Upload deferred:', err);
        } finally {
            this.syncing = false;
            if (this.resyncRequested) { this.resyncRequested = false; this.syncPending(); }
        }
    }

    /** Fallback for missed WebSocket pushes: asks the server for the latest status. */
    private async refreshStatuses() {
        if (!navigator.onLine) return;
        const tracked = (await offlineStorage.getAllMessages())
            .filter(m => m.cloudSynced && m.rescueStatus !== 'rescued' && m.rescueStatus !== 'false_alarm');
        if (tracked.length === 0) return;
        try {
            const ids = tracked.map(m => encodeURIComponent(m.id)).join(',');
            const res = await fetch(`${API_BASE}/api/sos/status?ids=${ids}`);
            if (!res.ok) return;
            for (const s of await res.json() as RescueStatusUpdate[]) this.applyStatus(s);
        } catch { /* next interval will retry */ }
    }

    private connect() {
        if (!navigator.onLine || this.socket) return;
        this.setState('connecting');
        const base = API_BASE || window.location.origin;
        const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
        this.socket = socket;

        socket.onopen = () => {
            this.backoff = 1_000;
            this.setState('connected');
            this.syncPending();
            this.refreshStatuses();
        };
        socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'status') this.applyStatus(msg.sos as RescueStatusUpdate);
            } catch { /* ignore malformed frames */ }
        };
        socket.onclose = () => {
            this.socket = null;
            this.setState(navigator.onLine ? 'connecting' : 'offline');
            if (!navigator.onLine) return;
            setTimeout(() => this.connect(), this.backoff);
            this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        };
        socket.onerror = () => socket.close();
    }

    private async applyStatus(s: RescueStatusUpdate) {
        await this.patchLocal(s.id, local =>
            local.rescueStatus === s.status && local.rescueTeam === s.teamName
                ? null
                : { ...local, ...statusFields(s) });
    }

    /** Re-reads the message before writing so concurrent mesh updates aren't lost. */
    private async patchLocal(id: string, fn: (m: SOSMessage) => SOSMessage | null) {
        const local = await offlineStorage.getMessage(id);
        if (!local) return;
        const next = fn(local);
        if (!next) return;
        await offlineStorage.saveMessage(next);
        this.updateListeners.forEach(cb => cb(next));
    }

    private setState(s: CloudState) {
        if (s === this.state) return;
        this.state = s;
        this.stateListeners.forEach(cb => cb(s));
    }
}

const statusFields = (s?: RescueStatusUpdate) =>
    s ? { rescueStatus: s.status, rescueTeam: s.teamName } : {};

/** Strips local-only fields before upload. */
const toWire = (m: SOSMessage) => ({
    id: m.id,
    text: m.text,
    location: m.location,
    timestamp: m.timestamp,
    isAutoTriggered: m.isAutoTriggered,
    isPanic: m.isPanic,
    fallSeverity: m.fallSeverity,
    fallImpact: m.fallImpact,
    senderId: m.senderId,
    hops: m.hops,
});

export const syncService = new CloudSyncService();
