import type { SOSMessage } from '../types/sos';

export type GpsState = 'unsupported' | 'idle' | 'searching' | 'ok' | 'denied' | 'unavailable';
type Fix = NonNullable<SOSMessage['location']> & { at: number };

// A fix younger than this is attached to an SOS straight away.
const FRESH_MS = 2 * 60_000;
// How long to keep trying for a fix after an SOS was sent without one.
const LATE_FIX_TIMEOUT_MS = 30_000;

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
    private listeners: ((s: GpsState) => void)[] = [];

    /** Starts watching. Safe to call repeatedly; call from a user tap on iOS. */
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
                // Notify on every fix, not just state changes: a waiter may need a fresh one.
                this.setState('ok', true);
            },
            err => {
                if (err.code === err.PERMISSION_DENIED) {
                    this.stop();
                    this.setState('denied');
                } else if (!this.lastFix) {
                    // Timeouts/unavailable are often temporary (indoors); keep watching.
                    this.setState('unavailable');
                }
            },
            { enableHighAccuracy: true, maximumAge: 30_000, timeout: 60_000 },
        );
    }

    stop() {
        if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
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

/** Starts GPS at app launch only if the user already granted permission. */
export async function startLocationIfPermitted() {
    try {
        const status = await navigator.permissions?.query({ name: 'geolocation' });
        if (status?.state === 'granted') locationService.start();
        status?.addEventListener('change', () => {
            if (status.state === 'granted') locationService.start();
        });
    } catch {
        // Permissions API missing (older Safari); GPS starts on the first tap instead.
    }
}
