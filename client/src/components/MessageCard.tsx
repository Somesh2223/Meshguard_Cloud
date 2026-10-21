import React from 'react';
import { Clock, MapPin, AlertCircle, Shield } from 'lucide-react';
import type { SOSMessage, RescueStatus } from '../types/sos';

const RESCUE_LABELS: Record<RescueStatus, { label: string; cls: string }> = {
    open: { label: 'Received by rescue control. Waiting for a team.', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
    acknowledged: { label: 'Rescue control has seen your SOS', cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
    en_route: { label: 'Team en route', cls: 'border-blue-500/40 bg-blue-500/10 text-blue-300' },
    rescued: { label: 'Marked rescued', cls: 'border-green-500/40 bg-green-500/10 text-green-300' },
    false_alarm: { label: 'Closed as false alarm', cls: 'border-slate-600 bg-slate-800/60 text-slate-400' },
};

interface MessageCardProps {
    message: SOSMessage;
}

export const MessageCard: React.FC<MessageCardProps> = ({ message }) => {
    const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isPanic = message.isPanic === true;
    const isAuto = message.isAutoTriggered;

    const containerClasses = isPanic
        ? 'border-orange-500/40 bg-orange-500/5'
        : isAuto
            ? 'border-red-500/30 bg-red-500/5'
            : 'border-white/5 bg-slate-900/40';

    return (
        <div
            className={`p-6 rounded-[2rem] border transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer ${containerClasses} backdrop-blur-lg space-y-4 shadow-xl`}
        >
            <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                    <div
                        className={`p-2 rounded-xl ${
                            isPanic
                                ? 'bg-orange-500/20 text-orange-300'
                                : isAuto
                                ? 'bg-red-500/20 text-red-400'
                                : 'bg-blue-500/10 text-blue-400'
                        }`}
                    >
                        {isAuto || isPanic ? (
                            <AlertCircle className="w-4 h-4" />
                        ) : (
                            <Shield className="w-4 h-4" />
                        )}
                    </div>
                    <div>
                        <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                            <Clock className="w-3 h-3" />
                            {time}
                        </div>
                        {isPanic && (
                            <span className="text-[10px] font-bold text-orange-400 uppercase tracking-wider">
                                Panic Alert
                            </span>
                        )}
                        {!isPanic && isAuto && (
                            <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">
                                Fall Intelligence Trigger
                            </span>
                        )}
                    </div>
                </div>
                <span className={`text-[9px] font-black px-3 py-1 rounded-full border tracking-widest ${message.status === 'relayed' ? 'border-blue-500/50 text-blue-400 bg-blue-500/5' :
                    message.status === 'queued' ? 'border-amber-500/50 text-amber-400 bg-amber-500/5' : 'border-slate-700 text-slate-500'
                    }`}>
                    {message.isTest ? 'TEST' : message.cloudSynced ? 'IN CLOUD' : message.status.toUpperCase()}
                </span>
            </div>

            <p className="text-slate-200 text-base font-medium leading-relaxed px-1">
                {message.text}
            </p>

            {message.rescueStatus && (
                <div className={`text-xs font-bold px-4 py-2.5 rounded-2xl border ${RESCUE_LABELS[message.rescueStatus].cls}`}>
                    {RESCUE_LABELS[message.rescueStatus].label}
                    {message.rescueTeam && message.rescueStatus !== 'open' && (
                        <span className="font-medium opacity-80"> · {message.rescueTeam}</span>
                    )}
                </div>
            )}

            <div className="flex items-center justify-between text-[10px] font-bold text-slate-500 pt-4 border-t border-white/5 uppercase tracking-widest px-1">
                <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500/50" />
                    Network Hops: {message.hops}
                </div>
                {message.location ? (
                    <div className="flex items-center gap-1.5 text-blue-400/80">
                        <MapPin className="w-3 h-3" />
                        Loc: {message.location.latitude.toFixed(3)}, {message.location.longitude.toFixed(3)}
                    </div>
                ) : message.locationStatus === 'pending' ? (
                    <div className="flex items-center gap-1.5 text-amber-400/80 animate-pulse">
                        <MapPin className="w-3 h-3" />
                        Locating…
                    </div>
                ) : !message.isTest && (
                    <div className="flex items-center gap-1.5 text-red-400/70">
                        <MapPin className="w-3 h-3" />
                        No location
                    </div>
                )}
            </div>
        </div>
    );
};
