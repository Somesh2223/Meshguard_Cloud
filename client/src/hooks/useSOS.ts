import { useState, useEffect } from 'react';
import type { SOSMessage } from '../types/sos';
import { offlineStorage } from '../services/OfflineStorage';
import { p2pMesh } from '../network/P2pMesh';
import { syncService, type CloudState } from '../services/SyncService';
import { deviceId } from '../utils/deviceId';
import { locationService, startLocationIfPermitted, type GpsState } from '../services/LocationService';

export interface SendSOSOptions {
    isAuto?: boolean;
    isPanic?: boolean;
    fallSeverity?: SOSMessage['fallSeverity'];
    fallImpact?: number;
}

const newId = (prefix: string) =>
    typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

export const useSOS = () => {
    const [messages, setMessages] = useState<SOSMessage[]>([]);
    const [isOnline, setIsOnline] = useState(navigator.onLine);
    const [cloudState, setCloudState] = useState<CloudState>('offline');
    const [gpsState, setGpsState] = useState<GpsState>(locationService.getState());

    useEffect(() => {
        const upsert = (msg: SOSMessage) =>
            setMessages(prev => {
                const i = prev.findIndex(m => m.id === msg.id);
                if (i === -1) return [msg, ...prev];
                const next = prev.slice();
                next[i] = msg;
                return next;
            });

        const loadMessages = async () => {
            const stored = await offlineStorage.getAllMessages();
            setMessages(stored.sort((a, b) => b.timestamp - a.timestamp));
        };

        loadMessages();

        // WebRTC Mesh listener: anything heard from a peer is forwarded to the cloud
        // as soon as this phone has internet.
        p2pMesh.onMessage((msg) => {
            upsert(msg);
            syncService.syncPending();
        });

        syncService.onMessageUpdated(upsert);
        syncService.onStateChange(setCloudState);
        syncService.start();

        startLocationIfPermitted();
        const stopGps = locationService.onStateChange(setGpsState);

        const handleStatus = () => setIsOnline(navigator.onLine);
        window.addEventListener('online', handleStatus);
        window.addEventListener('offline', handleStatus);

        return () => {
            stopGps();
            window.removeEventListener('online', handleStatus);
            window.removeEventListener('offline', handleStatus);
        };
    }, []);

    const sendSOS = async (text: string, options: SendSOSOptions = {}) => {
        const message: SOSMessage = {
            id: newId('msg'),
            text,
            timestamp: Date.now(),
            status: 'queued',
            isAutoTriggered: options.isAuto ?? false,
            isPanic: options.isPanic,
            fallSeverity: options.fallSeverity,
            fallImpact: options.fallImpact,
            senderId: deviceId,
            hops: 0,
        };

        // Never hold an SOS back waiting for GPS: send now with the latest fix,
        // and if there isn't a fresh one, follow up with the location below.
        locationService.start();
        message.location = locationService.current();
        if (!message.location) message.locationStatus = 'pending';

        await offlineStorage.saveMessage(message);
        setMessages(prev => [message, ...prev]);

        // Both paths run: the cloud if this phone is online, the mesh for phones
        // nearby that might reach the internet first.
        syncService.syncPending();
        const peerCount = p2pMesh.getPeerCount();
        if (peerCount > 0) {
            console.log(`[useSOS] Broadcasting to ${peerCount} peers`);
            p2pMesh.broadcast(message);
        } else {
            console.log('[useSOS] No peers connected, message queued locally');
        }

        if (!message.location) attachLateLocation(message.id);
        return message;
    };

    const attachLateLocation = async (id: string) => {
        const fix = await locationService.waitForFix();
        const stored = await offlineStorage.getMessage(id);
        if (!stored || stored.location) return;
        const next: SOSMessage = fix
            ? { ...stored, location: fix, locationStatus: undefined, cloudSynced: false }
            : { ...stored, locationStatus: 'none' };
        await offlineStorage.saveMessage(next);
        setMessages(prev => prev.map(m => (m.id === id ? next : m)));
        if (fix) {
            syncService.syncPending();
            if (p2pMesh.getPeerCount() > 0) p2pMesh.broadcast(next);
        }
    };

    const sendTestMessage = async () => {
        const testMessage: SOSMessage = {
            id: newId('test'),
            text: '🧪 Test Message - Mesh Network Active',
            timestamp: Date.now(),
            status: 'sent',
            isAutoTriggered: false,
            isTest: true,
            senderId: deviceId,
            hops: 0,
        };

        await offlineStorage.saveMessage(testMessage);
        setMessages(prev => [testMessage, ...prev]);

        const peerCount = p2pMesh.getPeerCount();
        if (peerCount > 0) {
            console.log(`[useSOS] Test message broadcasting to ${peerCount} peers`);
            p2pMesh.broadcast(testMessage);
        }

        return testMessage;
    };

    const enableGps = () => locationService.start();

    return { messages, isOnline, cloudState, gpsState, enableGps, sendSOS, sendTestMessage };
};
