// Stable id for this device, sent as senderId and as the uploader when syncing.
// One per browser (localStorage), matching the IndexedDB message store, which is
// also shared by every tab of the app. To demo a mesh relay, use two devices or
// two different browsers.
const KEY = 'sos-device-id';

const makeId = () =>
    `dev-${typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10)}`;

function load(): string {
    try {
        const existing = localStorage.getItem(KEY);
        if (existing) return existing;
        const id = makeId();
        localStorage.setItem(KEY, id);
        return id;
    } catch {
        return makeId();
    }
}

export const deviceId = load();
