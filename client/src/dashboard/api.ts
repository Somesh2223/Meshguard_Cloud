import type { RescueStatus } from '../types/sos';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const KEY_STORAGE = 'rescue-dashboard-key';

export interface Sos {
    id: string;
    text: string;
    location: { latitude: number; longitude: number; accuracy: number | null } | null;
    createdAt: number;
    receivedAt: number;
    isPanic: boolean;
    isAutoTriggered: boolean;
    fallSeverity: string | null;
    fallImpact: number | null;
    senderId: string;
    hops: number;
    uploadedBy: string | null;
    relayed: boolean;
    priority: 1 | 2 | 3;
    status: RescueStatus;
    team: { id: number; name: string } | null;
    note: string | null;
    updatedAt: number;
}

export interface SosEvent { at: number; action: string; detail: string | null }
export interface SosDetail extends Sos { events: SosEvent[] }

export interface Team {
    id: number;
    name: string;
    contact: string | null;
    status: 'available' | 'busy' | 'offline';
    activeCases: number;
}

export interface Stats {
    byStatus: Record<RescueStatus, number>;
    activeCritical: number;
    relayedThroughMesh: number;
    avgTimeToRescueMs: number | null;
    teams: Partial<Record<Team['status'], number>>;
}

export class UnauthorizedError extends Error {}

export const savedKey = () => {
    try { return localStorage.getItem(KEY_STORAGE); } catch { return null; }
};
export const saveKey = (k: string | null) => {
    try { k ? localStorage.setItem(KEY_STORAGE, k) : localStorage.removeItem(KEY_STORAGE); } catch { /* private mode */ }
};

export async function api<T>(key: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-dashboard-key': key, ...init.headers },
    });
    if (res.status === 401) throw new UnauthorizedError('Wrong passcode');
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.status === 204 ? (undefined as T) : res.json();
}

export const wsUrl = (key: string) =>
    `${(API_BASE || window.location.origin).replace(/^http/, 'ws')}/ws?key=${encodeURIComponent(key)}`;

export const STATUS_META: Record<RescueStatus, { label: string; dot: string; chip: string }> = {
    open: { label: 'Open', dot: 'bg-red-500', chip: 'bg-red-500/15 text-red-300 border-red-500/30' },
    acknowledged: { label: 'Acknowledged', dot: 'bg-amber-400', chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
    en_route: { label: 'En route', dot: 'bg-blue-400', chip: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
    rescued: { label: 'Rescued', dot: 'bg-green-500', chip: 'bg-green-500/15 text-green-300 border-green-500/30' },
    false_alarm: { label: 'False alarm', dot: 'bg-slate-500', chip: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
};

export const PRIORITY_META = {
    1: { label: 'Critical', color: '#ef4444', chip: 'bg-red-600 text-white' },
    2: { label: 'High', color: '#f59e0b', chip: 'bg-amber-500 text-slate-950' },
    3: { label: 'Normal', color: '#3b82f6', chip: 'bg-slate-700 text-slate-200' },
} as const;

export const isClosed = (s: RescueStatus) => s === 'rescued' || s === 'false_alarm';

export function timeAgo(ts: number, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function formatDuration(ms: number | null) {
    if (ms == null) return '—';
    const m = Math.round(ms / 60000);
    if (m < 1) return '<1 min';
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}
