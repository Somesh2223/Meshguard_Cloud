import type { SOSMessage } from '../types/sos';

export type GpsState = 'unsupported' | 'idle' | 'searching' | 'ok' | 'denied' | 'unavailable';
export interface GpsError { code: number; message: string }
type Fix = NonNullable<SOSMessage['location']> & { at: number };

// A fix younger than this is attached to an SOS straight away.
const FRESH_MS = 2 * 60_000;
// How long to keep trying for a fix after an SOS was sent without one.
const LATE_FIX_TIMEOUT_MS = 30_000;
// Set once this browser has delivered a fix, so later visits can warm GPS up at
// launch. Needed because Safari's Permissions API reports "prompt" until the page
// has used geolocation, even when the site is allowed.
const CONSENT_KEY = 'sos-gps-consent';
const DRAFT_KEY = 'sos-draft';

const storage = {
    get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k: string) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

export const isIOS = () =>
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Keeps a warm GPS fix while the app is open.
 *
 * Asking for a position only when SOS is pressed fails on many phones: the
 * first fix after the GPS wakes up can take 5–20 s. Watching continuously means
 * a recent position is usually ready the moment it is needed.
 */
class LocationService {
    private lastFix: Fix | null = null;
    private watchId: number | null = null;
    private state: GpsState = 'geolocation' in navigator ? 'idle' : 'unsupported';
    private lastError: GpsError | null = null;
    private listeners: ((s: GpsState) => void)[] = [];

    /** Starts watching. Safe to call repeatedly. */
    start() {
        if (this.state === 'unsupported' || this.watchId !== null) return;
        this.setState(this.lastFix ? 'ok' : 'searching');
        this.watchId = navigator.geolocation.watchPosition(
            pos => {
                this.lastFix = {
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    at: Date.now(),
                };
                this.lastError = null;
                storage.set(CONSENT_KEY, '1');
                // Notify on every fix, not just state changes: a waiter may need a fresh one.
                this.setState('ok', true);
            },
            err => {
                this.lastError = { code: err.code, message: err.message };
                if (err.code === err.PERMISSION_DENIED) {
                    // WebKit keeps a denial for the rest of the page's life: every
                    // later request fails without a prompt, even after the user
                    // allows it in Settings. Only a reload can recover (see retry()).
                    this.stop();
                    storage.del(CONSENT_KEY);
                    this.setState('denied', true);
                } else if (!this.lastFix) {
                    // Timeouts/unavailable are often temporary (indoors); keep watching.
                    this.setState('unavailable', true);
                }
            },
            { enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 },
        );
    }

    stop() {
        if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
    }

    /**
     * Recovers from a denial. Browsers that cache the denial for the page
     * (Safari) need a fresh page load; the typed SOS text survives the reload.
     */
    retry(draft: string) {
        if (this.state !== 'denied') { this.start(); return; }
        try { sessionStorage.setItem(DRAFT_KEY, draft); } catch { /* ignore */ }
        storage.set(CONSENT_KEY, '1');
        window.location.reload();
    }

    /** A recent position, or null if none is fresh enough. */
    current(): SOSMessage['location'] | undefined {
        if (!this.lastFix || Date.now() - this.lastFix.at > FRESH_MS) return undefined;
        const { latitude, longitude, accuracy } = this.lastFix;
        return { latitude, longitude, accuracy };
    }

    /** Resolves with the next good fix, or null after a timeout or denial. */
    waitForFix(timeoutMs = LATE_FIX_TIMEOUT_MS): Promise<SOSMessage['location'] | null> {
        const now = this.current();
        if (now) return Promise.resolve(now);
        if (this.state === 'unsupported' || this.state === 'denied') return Promise.resolve(null);
        this.start();
        return new Promise(resolve => {
            const done = (v: SOSMessage['location'] | null) => {
                clearTimeout(timer);
                this.listeners = this.listeners.filter(l => l !== onState);
                resolve(v);
            };
            const onState = (s: GpsState) => {
                if (s === 'ok') done(this.current() ?? null);
                else if (s === 'denied') done(null);
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            this.listeners.push(onState);
        });
    }

    getState() { return this.state; }
    getError() { return this.lastError; }

    onStateChange(cb: (s: GpsState) => void) {
        this.listeners.push(cb);
        cb(this.state);
        return () => { this.listeners = this.listeners.filter(l => l !== cb); };
    }

    private setState(s: GpsState, always = false) {
        if (s === this.state && !always) return;
        this.state = s;
        [...this.listeners].forEach(cb => cb(s));
    }
}

export const locationService = new LocationService();

/** SOS text saved before a recovery reload, if any (read once). */
export function takeDraft(): string {
    try {
        const d = sessionStorage.getItem(DRAFT_KEY) ?? '';
        sessionStorage.removeItem(DRAFT_KEY);
        return d;
    } catch {
        return '';
    }
}

/**
 * Starts GPS at app launch when the user has already agreed: either the
 * Permissions API says granted (Chrome/Android), or this browser delivered a
 * fix before (Safari, whose Permissions API can't be trusted for this).
 * Otherwise GPS waits for an explicit tap, so the permission prompt never
 * appears unexpectedly and can't be dismissed by accident.
 */
export async function startLocationIfPermitted() {
    if (storage.get(CONSENT_KEY)) { locationService.start(); return; }
    try {
        const status = await navigator.permissions?.query({ name: 'geolocation' });
        if (status?.state === 'granted') locationService.start();
        status?.addEventListener('change', () => {
            if (status.state === 'granted') locationService.start();
        });
    } catch {
        // Permissions API missing; GPS starts on the first tap instead.
    }
}
