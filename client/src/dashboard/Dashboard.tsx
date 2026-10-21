import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle, CheckCircle2, Clock, LogOut, MapPin, Plus, Radio, ShieldAlert, Truck, Users, Wifi, WifiOff, X,
} from 'lucide-react';
import {
    api, savedKey, saveKey, wsUrl, UnauthorizedError, STATUS_META, PRIORITY_META, isClosed, timeAgo, formatDuration,
    type Sos, type SosDetail, type Team, type Stats,
} from './api';
import { SosMap } from './SosMap';
import type { RescueStatus } from '../types/sos';

type Filter = 'active' | 'closed' | 'all';
interface Toast { id: number; text: string; critical: boolean }

const upsertSos = (list: Sos[], s: Sos) => {
    const i = list.findIndex(x => x.id === s.id);
    if (i === -1) return [s, ...list];
    const next = list.slice();
    next[i] = s;
    return next;
};

const sortQueue = (a: Sos, b: Sos) =>
    Number(isClosed(a.status)) - Number(isClosed(b.status)) || a.priority - b.priority || a.receivedAt - b.receivedAt;

function beep(critical: boolean) {
    try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = critical ? 880 : 660;
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
    } catch { /* audio blocked until the user interacts */ }
}

export function Dashboard() {
    const [key, setKey] = useState<string | null>(savedKey);
    return key
        ? <ControlRoom passcode={key} onLogout={() => { saveKey(null); setKey(null); }} />
        : <Login onLogin={k => { saveKey(k); setKey(k); }} />;
}

function Login({ onLogin }: { onLogin: (k: string) => void }) {
    const [value, setValue] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
            await api(value, '/api/auth/check', { method: 'POST' });
            onLogin(value);
        } catch (err) {
            setError(err instanceof UnauthorizedError ? 'Wrong passcode' : 'Cannot reach the rescue server');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-slate-950">
            <form onSubmit={submit} className="w-full max-w-sm space-y-5 bg-slate-900 border border-white/10 rounded-3xl p-8">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-red-500/15 rounded-xl"><ShieldAlert className="w-6 h-6 text-red-400" /></div>
                    <div>
                        <h1 className="text-xl font-black tracking-tight">Rescue Control</h1>
                        <p className="text-xs text-slate-400">Disaster SOS coordination</p>
                    </div>
                </div>
                <label className="block space-y-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Rescuer passcode</span>
                    <input
                        type="password" autoFocus value={value} onChange={e => setValue(e.target.value)}
                        className="w-full bg-slate-800 border border-white/10 rounded-xl px-4 py-3 outline-none focus:border-blue-500"
                    />
                </label>
                {error && <p className="text-sm text-red-400">{error}</p>}
                <button disabled={!value || busy} className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 font-bold">
                    {busy ? 'Checking…' : 'Open control room'}
                </button>
            </form>
        </div>
    );
}

function ControlRoom({ passcode, onLogout }: { passcode: string; onLogout: () => void }) {
    const [sos, setSos] = useState<Sos[]>([]);
    const [teams, setTeams] = useState<Team[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [filter, setFilter] = useState<Filter>('active');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detail, setDetail] = useState<SosDetail | null>(null);
    const [live, setLive] = useState(false);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [showTeams, setShowTeams] = useState(false);
    const [error, setError] = useState('');
    const [, setTick] = useState(0);
    const selectedRef = useRef(selectedId);
    selectedRef.current = selectedId;

    const call = useCallback(async <T,>(path: string, init?: RequestInit) => {
        try {
            return await api<T>(passcode, path, init);
        } catch (err) {
            if (err instanceof UnauthorizedError) onLogout();
            throw err;
        }
    }, [passcode, onLogout]);

    const refreshStats = useCallback(() => { call<Stats>('/api/stats').then(setStats).catch(() => {}); }, [call]);

    const loadDetail = useCallback((id: string) => {
        call<SosDetail>(`/api/sos/${encodeURIComponent(id)}`).then(d => {
            if (selectedRef.current === id) setDetail(d);
        }).catch(() => {});
    }, [call]);

    // Initial load
    useEffect(() => {
        Promise.all([call<Sos[]>('/api/sos'), call<Team[]>('/api/teams'), call<Stats>('/api/stats')])
            .then(([s, t, st]) => { setSos(s); setTeams(t); setStats(st); })
            .catch(err => setError(err.message));
    }, [call]);

    // Keeps the "x minutes ago" labels fresh.
    useEffect(() => {
        const t = setInterval(() => setTick(n => n + 1), 20_000);
        return () => clearInterval(t);
    }, []);

    // Live updates
    useEffect(() => {
        let socket: WebSocket | null = null;
        let retry: ReturnType<typeof setTimeout>;
        let stopped = false;
        let delay = 1000;

        const connect = () => {
            socket = new WebSocket(wsUrl(passcode));
            socket.onopen = () => {
                setLive(true);
                delay = 1000;
                // Catch up on anything that arrived while disconnected.
                call<Sos[]>('/api/sos').then(setSos).catch(() => {});
                refreshStats();
            };
            socket.onmessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'sos:new') {
                    const s = msg.sos as Sos;
                    setSos(list => upsertSos(list, s));
                    const critical = s.priority === 1;
                    const id = Date.now() + Math.random();
                    setToasts(t => [...t, {
                        id, critical,
                        text: `${PRIORITY_META[s.priority].label} SOS${s.relayed ? ` (via mesh, ${s.hops} hops)` : ''}: ${s.text.slice(0, 80)}`,
                    }]);
                    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 8000);
                    beep(critical);
                    refreshStats();
                } else if (msg.type === 'sos:update') {
                    const s = msg.sos as Sos;
                    setSos(list => upsertSos(list, s));
                    if (selectedRef.current === s.id) loadDetail(s.id);
                    refreshStats();
                } else if (msg.type === 'teams') {
                    setTeams(msg.teams);
                }
            };
            socket.onclose = () => {
                setLive(false);
                if (stopped) return;
                retry = setTimeout(connect, delay);
                delay = Math.min(delay * 2, 15000);
            };
        };
        connect();
        return () => { stopped = true; clearTimeout(retry); socket?.close(); };
    }, [passcode, call, refreshStats, loadDetail]);

    useEffect(() => {
        if (selectedId) loadDetail(selectedId); else setDetail(null);
    }, [selectedId, loadDetail]);

    const visible = useMemo(() => sos
        .filter(s => filter === 'all' || (filter === 'active' ? !isClosed(s.status) : isClosed(s.status)))
        .sort(sortQueue), [sos, filter]);

    const update = async (id: string, body: { status?: RescueStatus; teamId?: number | null; note?: string }) => {
        try {
            const d = await call<SosDetail>(`/api/sos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
            setSos(list => upsertSos(list, d));
            if (selectedRef.current === id) setDetail(d);
            refreshStats();
        } catch (err) {
            setError((err as Error).message);
        }
    };

    const active = stats ? stats.byStatus.open + stats.byStatus.acknowledged + stats.byStatus.en_route : 0;

    return (
        <div className="h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
            {/* Top bar */}
            <header className="flex items-center justify-between gap-3 px-4 md:px-6 py-3 border-b border-white/5 bg-slate-900/60">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 bg-red-500/15 rounded-xl shrink-0"><ShieldAlert className="w-5 h-5 text-red-400" /></div>
                    <div className="min-w-0">
                        <h1 className="font-black tracking-tight truncate">Rescue Control</h1>
                        <p className="text-[11px] text-slate-400 truncate">Disaster SOS coordination · AWS EC2</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg border ${live ? 'border-green-500/30 text-green-300 bg-green-500/10' : 'border-amber-500/30 text-amber-300 bg-amber-500/10'}`}>
                        {live ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                        <span className="hidden sm:inline">{live ? 'Live' : 'Reconnecting'}</span>
                    </span>
                    <button onClick={() => setShowTeams(true)} className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-white/5">
                        <Users className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Teams</span>
                    </button>
                    <button onClick={onLogout} title="Log out" className="p-2 rounded-lg hover:bg-slate-800 text-slate-400">
                        <LogOut className="w-4 h-4" />
                    </button>
                </div>
            </header>

            {/* Stats */}
            <div className="grid grid-cols-3 lg:grid-cols-6 gap-2 px-4 md:px-6 py-3 border-b border-white/5">
                <Stat label="Active" value={active} />
                <Stat label="Critical active" value={stats?.activeCritical ?? 0} danger />
                <Stat label="Unassigned" value={stats?.byStatus.open ?? 0} />
                <Stat label="Rescued" value={stats?.byStatus.rescued ?? 0} good />
                <Stat label="Via mesh relay" value={stats?.relayedThroughMesh ?? 0} />
                <Stat label="Avg time to rescue" value={formatDuration(stats?.avgTimeToRescueMs ?? null)} />
            </div>

            {error && (
                <div className="mx-4 md:mx-6 mt-3 flex items-center justify-between gap-3 text-sm px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300">
                    {error}
                    <button onClick={() => setError('')}><X className="w-4 h-4" /></button>
                </div>
            )}

            {/* Main: queue · map · detail */}
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 p-3 md:p-4 overflow-y-auto lg:overflow-hidden">
                <section className="lg:w-[360px] shrink-0 flex flex-col min-h-0 bg-slate-900/50 border border-white/5 rounded-2xl">
                    <div className="flex items-center gap-1 p-2 border-b border-white/5">
                        {(['active', 'closed', 'all'] as Filter[]).map(f => (
                            <button key={f} onClick={() => setFilter(f)}
                                className={`flex-1 text-xs font-bold uppercase tracking-wider py-2 rounded-lg ${filter === f ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800'}`}>
                                {f}
                            </button>
                        ))}
                    </div>
                    <div className="flex-1 min-h-0 overflow-y-auto max-h-[50vh] lg:max-h-none p-2 space-y-2">
                        {visible.length === 0 && (
                            <p className="text-center text-sm text-slate-500 py-10">
                                {filter === 'active' ? 'No active SOS calls' : 'Nothing here yet'}
                            </p>
                        )}
                        {visible.map(s => (
                            <button key={s.id} onClick={() => setSelectedId(s.id)}
                                className={`w-full text-left p-3 rounded-xl border transition-colors ${s.id === selectedId ? 'border-blue-500 bg-blue-500/10' : 'border-white/5 bg-slate-900 hover:bg-slate-800'}`}>
                                <div className="flex items-center gap-2 mb-1.5">
                                    <span className={`text-[10px] font-black uppercase px-1.5 py-0.5 rounded ${PRIORITY_META[s.priority].chip}`}>
                                        {PRIORITY_META[s.priority].label}
                                    </span>
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_META[s.status].chip}`}>
                                        {STATUS_META[s.status].label}
                                    </span>
                                    {s.relayed && <span title={`Relayed over ${s.hops} hop(s)`}><Radio className="w-3.5 h-3.5 text-indigo-300" /></span>}
                                    <span className="ml-auto text-[11px] text-slate-500">{timeAgo(s.receivedAt)}</span>
                                </div>
                                <p className="text-sm text-slate-200 line-clamp-2">{s.text}</p>
                                <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-500">
                                    {s.team && <span className="flex items-center gap-1"><Truck className="w-3 h-3" />{s.team.name}</span>}
                                    {!s.location && <span className="flex items-center gap-1 text-amber-400/80"><MapPin className="w-3 h-3" />No location</span>}
                                </div>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="flex-1 min-h-[320px] lg:min-h-0 bg-slate-900/50 border border-white/5 rounded-2xl p-1">
                    <SosMap sos={sos} selectedId={selectedId} onSelect={setSelectedId} />
                </section>

                {detail && (
                    <DetailPanel key={detail.id} sos={detail} teams={teams} onClose={() => setSelectedId(null)} onUpdate={body => update(detail.id, body)} />
                )}
            </div>

            {showTeams && <TeamsModal teams={teams} call={call} onClose={() => setShowTeams(false)} onError={setError} />}

            {/* Toasts */}
            <div className="fixed bottom-4 right-4 left-4 sm:left-auto sm:w-96 space-y-2 z-[1000]">
                {toasts.map(t => (
                    <div key={t.id} className={`flex items-start gap-3 p-3 rounded-xl border shadow-2xl text-sm ${t.critical ? 'bg-red-950 border-red-500/50' : 'bg-slate-900 border-white/10'}`}>
                        <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${t.critical ? 'text-red-400' : 'text-amber-400'}`} />
                        <span>{t.text}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function Stat({ label, value, danger, good }: { label: string; value: number | string; danger?: boolean; good?: boolean }) {
    const color = danger && value ? 'text-red-400' : good ? 'text-green-400' : 'text-white';
    return (
        <div className="bg-slate-900/60 border border-white/5 rounded-xl px-3 py-2">
            <div className={`text-xl font-black tabular-nums ${color}`}>{value}</div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 truncate">{label}</div>
        </div>
    );
}

const ACTIONS: { status: RescueStatus; label: string; cls: string }[] = [
    { status: 'acknowledged', label: 'Acknowledge', cls: 'bg-amber-500 hover:bg-amber-400 text-slate-950' },
    { status: 'en_route', label: 'Team en route', cls: 'bg-blue-600 hover:bg-blue-500' },
    { status: 'rescued', label: 'Rescued', cls: 'bg-green-600 hover:bg-green-500' },
    { status: 'false_alarm', label: 'False alarm', cls: 'bg-slate-700 hover:bg-slate-600' },
];

function DetailPanel({ sos, teams, onClose, onUpdate }: {
    sos: SosDetail; teams: Team[]; onClose: () => void;
    onUpdate: (body: { status?: RescueStatus; teamId?: number | null; note?: string }) => void;
}) {
    const [note, setNote] = useState(sos.note ?? '');

    const assign = (value: string) => {
        const teamId = value ? Number(value) : null;
        // Assigning a team to a fresh call also acknowledges it.
        onUpdate(teamId != null && sos.status === 'open' ? { teamId, status: 'acknowledged' } : { teamId });
    };

    return (
        <aside className="lg:w-[360px] shrink-0 flex flex-col min-h-0 bg-slate-900/50 border border-white/5 rounded-2xl">
            <div className="flex items-center justify-between p-4 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-black uppercase px-1.5 py-0.5 rounded ${PRIORITY_META[sos.priority].chip}`}>
                        {PRIORITY_META[sos.priority].label}
                    </span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_META[sos.status].chip}`}>
                        {STATUS_META[sos.status].label}
                    </span>
                </div>
                <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
                <p className="text-[15px] leading-relaxed">{sos.text}</p>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <dt className="text-slate-500">Sent</dt>
                    <dd>{new Date(sos.createdAt).toLocaleString()}</dd>
                    <dt className="text-slate-500">Reached cloud</dt>
                    <dd>{timeAgo(sos.receivedAt)}</dd>
                    <dt className="text-slate-500">Path</dt>
                    <dd>{sos.relayed ? `Mesh relay, ${sos.hops} hop(s)` : 'Direct upload'}</dd>
                    <dt className="text-slate-500">Location</dt>
                    <dd>
                        {sos.location ? (
                            <a className="text-blue-400 hover:underline" target="_blank" rel="noreferrer"
                                href={`https://www.google.com/maps?q=${sos.location.latitude},${sos.location.longitude}`}>
                                {sos.location.latitude.toFixed(5)}, {sos.location.longitude.toFixed(5)}
                            </a>
                        ) : <span className="text-amber-400">Unknown</span>}
                        {sos.location?.accuracy != null && <span className="text-slate-500"> ±{Math.round(sos.location.accuracy)} m</span>}
                    </dd>
                    {sos.fallSeverity && (<>
                        <dt className="text-slate-500">Fall</dt>
                        <dd className="capitalize">{sos.fallSeverity}{sos.fallImpact != null && ` · ${sos.fallImpact.toFixed(1)} m/s²`}</dd>
                    </>)}
                    <dt className="text-slate-500">Device</dt>
                    <dd className="font-mono text-[11px] text-slate-400">{sos.senderId}</dd>
                </dl>

                <label className="block space-y-1.5">
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Assigned team</span>
                    <select value={sos.team?.id ?? ''} onChange={e => assign(e.target.value)}
                        className="w-full bg-slate-800 border border-white/10 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-500">
                        <option value="">Unassigned</option>
                        {teams.map(t => (
                            <option key={t.id} value={t.id} disabled={t.status === 'offline'}>
                                {t.name} ({t.status}{t.activeCases ? `, ${t.activeCases} active` : ''})
                            </option>
                        ))}
                    </select>
                </label>

                <div className="grid grid-cols-2 gap-2">
                    {ACTIONS.map(a => (
                        <button key={a.status} disabled={sos.status === a.status} onClick={() => onUpdate({ status: a.status })}
                            className={`py-2.5 rounded-xl text-sm font-bold disabled:opacity-30 ${a.cls}`}>
                            {a.label}
                        </button>
                    ))}
                </div>

                <label className="block space-y-1.5">
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Notes</span>
                    <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
                        onBlur={() => note !== (sos.note ?? '') && onUpdate({ note })}
                        placeholder="Access route, injuries, people count…"
                        className="w-full bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-500 resize-none" />
                </label>

                <div className="space-y-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-500">Timeline</span>
                    <ol className="space-y-2 border-l border-white/10 ml-1.5">
                        {sos.events.map((e, i) => (
                            <li key={i} className="pl-4 relative text-xs">
                                <span className="absolute -left-[5px] top-1 w-2.5 h-2.5 rounded-full bg-slate-600" />
                                <span className="font-bold capitalize">{e.action}</span>
                                {e.detail && <span className="text-slate-400"> · {e.detail}</span>}
                                <div className="text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" />{new Date(e.at).toLocaleTimeString()}</div>
                            </li>
                        ))}
                    </ol>
                </div>
            </div>
        </aside>
    );
}

function TeamsModal({ teams, call, onClose, onError }: {
    teams: Team[];
    call: <T>(path: string, init?: RequestInit) => Promise<T>;
    onClose: () => void;
    onError: (msg: string) => void;
}) {
    const [name, setName] = useState('');
    const [contact, setContact] = useState('');

    const run = (p: Promise<unknown>) => p.catch(err => onError(err.message));

    const add = (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;
        run(call('/api/teams', { method: 'POST', body: JSON.stringify({ name: name.trim(), contact: contact.trim() || undefined }) }));
        setName('');
        setContact('');
    };

    return (
        <div className="fixed inset-0 z-[1100] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
            <div className="w-full max-w-lg bg-slate-900 border border-white/10 rounded-3xl p-6 space-y-5" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-black flex items-center gap-2"><Users className="w-5 h-5" /> Rescue teams</h2>
                    <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"><X className="w-4 h-4" /></button>
                </div>
                <ul className="space-y-2 max-h-[45vh] overflow-y-auto">
                    {teams.length === 0 && <li className="text-sm text-slate-500">No teams yet. Add one below.</li>}
                    {teams.map(t => (
                        <li key={t.id} className="flex items-center gap-3 p-3 rounded-xl bg-slate-800/60 border border-white/5">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${t.status === 'available' ? 'bg-green-500' : t.status === 'busy' ? 'bg-amber-400' : 'bg-slate-500'}`} />
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-sm truncate">{t.name}</div>
                                <div className="text-[11px] text-slate-400 truncate">
                                    {t.contact || 'No contact'} · {t.activeCases} active case{t.activeCases === 1 ? '' : 's'}
                                </div>
                            </div>
                            <select value={t.status}
                                onChange={e => run(call(`/api/teams/${t.id}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }))}
                                className="bg-slate-900 border border-white/10 rounded-lg px-2 py-1 text-xs">
                                <option value="available">Available</option>
                                <option value="busy">Busy</option>
                                <option value="offline">Offline</option>
                            </select>
                            <button title="Remove team" onClick={() => run(call(`/api/teams/${t.id}`, { method: 'DELETE' }))}
                                className="p-1.5 rounded-lg hover:bg-red-500/20 text-slate-500 hover:text-red-300"><X className="w-3.5 h-3.5" /></button>
                        </li>
                    ))}
                </ul>
                <form onSubmit={add} className="flex flex-col sm:flex-row gap-2">
                    <input value={name} onChange={e => setName(e.target.value)} placeholder="Team name"
                        className="flex-1 min-w-0 bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <input value={contact} onChange={e => setContact(e.target.value)} placeholder="Contact (optional)"
                        className="flex-1 min-w-0 bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-500" />
                    <button className="flex items-center justify-center gap-1 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-bold">
                        <Plus className="w-4 h-4" /> Add
                    </button>
                </form>
                <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Teams become busy when assigned and free up when their cases close.
                </p>
            </div>
        </div>
    );
}
