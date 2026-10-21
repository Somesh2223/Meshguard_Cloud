import React, { useState } from 'react';
import { Send, MapPin, AlertTriangle, RotateCcw } from 'lucide-react';
import { isIOS, takeDraft, type GpsError, type GpsState } from '../services/LocationService';

const GPS_LABEL: Record<Exclude<GpsState, 'idle' | 'denied'>, { text: string; dot: string }> = {
    ok: { text: 'GPS location ready', dot: 'bg-green-500' },
    searching: { text: 'Finding your location…', dot: 'bg-amber-400 animate-pulse' },
    unavailable: { text: 'No GPS signal yet; try near a window', dot: 'bg-amber-500 animate-pulse' },
    unsupported: { text: 'Location not supported on this device', dot: 'bg-red-500' },
};

const IOS_STEPS = [
    'iPhone Settings → Privacy & Security → Location Services: On',
    'Same screen → Safari Websites → "While Using the App" (or "Ask Next Time")',
    'In Safari tap aA (left of the address) → Website Settings → Location → Allow',
    'Come back here and tap Try again',
];

const OTHER_STEPS = [
    'Turn on Location in the phone\'s quick settings',
    'Tap the icon left of the address → Permissions (or Site settings) → Location → Allow',
    'Come back here and tap Try again',
];

interface SosFormProps {
    onSend: (text: string) => void;
    gpsState: GpsState;
    gpsError: GpsError | null;
    onEnableGps: () => void;
    onRetryGps: (draft: string) => void;
}

export const SosForm: React.FC<SosFormProps> = ({ onSend, gpsState, gpsError, onEnableGps, onRetryGps }) => {
    const [text, setText] = useState(takeDraft);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (text.trim()) {
            onSend(text);
            setText('');
        }
    };

    return (
        <div className="bg-slate-900/60 backdrop-blur-2xl p-8 rounded-[2.5rem] border border-white/5 shadow-2xl relative overflow-hidden group">
            {/* Accent Glow */}
            <div className="absolute top-0 right-0 w-32 h-32 bg-red-500/10 blur-3xl rounded-full -mr-16 -mt-16 group-hover:bg-red-500/20 transition-all duration-700" />

            <div className="flex items-center gap-3 text-red-500 mb-6 px-1">
                <div className="p-2 bg-red-500/10 rounded-xl">
                    <AlertTriangle className="w-6 h-6 animate-pulse" />
                </div>
                <h2 className="text-xl font-bold tracking-tight">Emergency SOS</h2>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6 relative z-10">
                <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="What is your emergency?"
                    className="w-full bg-slate-950/50 border border-slate-800 rounded-[1.5rem] p-5 text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500/50 transition-all min-h-[140px] text-lg resize-none shadow-inner"
                />

                {gpsState === 'denied' && (
                    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 space-y-3 text-sm">
                        <p className="font-bold text-red-300 flex items-center gap-2">
                            <MapPin className="w-4 h-4" /> Location is blocked
                        </p>
                        <p className="text-slate-300">
                            An SOS still works without it, but rescuers won't see where you are. To allow it:
                        </p>
                        <ol className="list-decimal pl-5 space-y-1 text-slate-300">
                            {(isIOS() ? IOS_STEPS : OTHER_STEPS).map(s => <li key={s}>{s}</li>)}
                        </ol>
                        {gpsError && (
                            <p className="text-[11px] text-slate-500 font-mono break-words">
                                Browser said: "{gpsError.message || 'permission denied'}" (code {gpsError.code})
                            </p>
                        )}
                        <button
                            type="button"
                            onClick={() => onRetryGps(text)}
                            className="w-full py-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 font-bold flex items-center justify-center gap-2"
                        >
                            <RotateCcw className="w-4 h-4" /> Try again
                        </button>
                    </div>
                )}

                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-1">
                    {gpsState === 'idle' ? (
                        <button
                            type="button"
                            onClick={onEnableGps}
                            className="w-full sm:w-auto flex items-center justify-center gap-2 text-sm font-bold text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3"
                        >
                            <MapPin className="w-4 h-4 shrink-0" />
                            Share my location
                        </button>
                    ) : gpsState !== 'denied' && (
                        <div className="flex items-center gap-2 text-sm font-medium text-slate-400">
                            <div className={`w-2 h-2 shrink-0 rounded-full ${GPS_LABEL[gpsState].dot}`} />
                            <MapPin className="w-4 h-4 shrink-0" />
                            <span>{GPS_LABEL[gpsState].text}</span>
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={!text.trim()}
                        className="w-full sm:w-auto bg-red-600 hover:bg-red-500 disabled:opacity-30 disabled:hover:bg-red-600 text-white font-black py-4 px-10 rounded-2xl flex items-center justify-center gap-3 transition-all active:scale-95 shadow-lg shadow-red-900/20 hover:shadow-red-600/40 uppercase tracking-widest text-xs"
                    >
                        <Send className="w-5 h-5 fill-current" />
                        Broadcast SOS
                    </button>
                </div>
            </form>
        </div>
    );
};
