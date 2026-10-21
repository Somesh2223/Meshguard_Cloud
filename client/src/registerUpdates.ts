import { registerSW } from 'virtual:pwa-register';

// The service worker keeps the app usable offline, but iOS Safari tends to keep
// running an old copy for a long time. In autoUpdate mode registerSW reloads the
// page as soon as a new version takes over; checking whenever the app comes back
// to the foreground makes that happen on the next visit, not days later.
export function registerUpdates() {
    registerSW({
        immediate: true,
        onRegisteredSW(_url, registration) {
            if (!registration) return;
            const check = () => {
                if (navigator.onLine && document.visibilityState === 'visible') {
                    registration.update().catch(() => { /* offline: try next time */ });
                }
            };
            document.addEventListener('visibilitychange', check);
            window.addEventListener('online', check);
            setInterval(check, 30 * 60_000);
        },
    });
}
