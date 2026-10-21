import { useState, useEffect } from 'react';
import type { SOSMessage } from '../types/sos';
import { offlineStorage } from '../services/OfflineStorage';
import { p2pMesh } from '../network/P2pMesh';
import { syncService, type CloudState } from '../services/SyncService';
import { deviceId } from '../utils/deviceId';

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

        const handleStatus = () => setIsOnline(navigator.onLine);
        window.addEventListener('online', handleStatus);
        window.addEventListener('offline', handleStatus);

        return () => {
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

        // Get location if possible
        try {
            const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
            });
            message.location = {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
            };
        } catch (err) {
            console.warn('Location retrieval failed or denied', err);
        }

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

        return message;
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

    return { messages, isOnline, cloudState, sendSOS, sendTestMessage };
};
