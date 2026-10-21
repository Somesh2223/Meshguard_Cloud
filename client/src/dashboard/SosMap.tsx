import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { PRIORITY_META, isClosed, type Sos } from './api';

interface SosMapProps {
    sos: Sos[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}

// Default view (India) until the first located SOS arrives.
const DEFAULT_CENTER: L.LatLngTuple = [20.59, 78.96];

export function SosMap({ sos, selectedId, onSelect }: SosMapProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<L.Map | null>(null);
    const layerRef = useRef<L.LayerGroup | null>(null);
    const fittedRef = useRef(false);
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;

    useEffect(() => {
        const map = L.map(containerRef.current!, { zoomControl: true }).setView(DEFAULT_CENTER, 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors',
        }).addTo(map);
        mapRef.current = map;
        layerRef.current = L.layerGroup().addTo(map);
        // The map sits in a flex layout; recompute size once it has settled.
        const ro = new ResizeObserver(() => map.invalidateSize());
        ro.observe(containerRef.current!);
        return () => { ro.disconnect(); map.remove(); };
    }, []);

    useEffect(() => {
        const map = mapRef.current, layer = layerRef.current;
        if (!map || !layer) return;
        layer.clearLayers();
        const located = sos.filter(s => s.location);

        // Draw closed cases first so active ones sit on top.
        const ordered = [...located].sort((a, b) => Number(isClosed(b.status)) - Number(isClosed(a.status)));
        for (const s of ordered) {
            const { latitude, longitude, accuracy } = s.location!;
            const closed = isClosed(s.status);
            const color = closed ? '#64748b' : PRIORITY_META[s.priority].color;
            const selected = s.id === selectedId;

            if (selected && accuracy) {
                L.circle([latitude, longitude], {
                    radius: accuracy, color, weight: 1, fillOpacity: 0.08, interactive: false,
                }).addTo(layer);
            }
            L.circleMarker([latitude, longitude], {
                radius: selected ? 13 : closed ? 6 : 9,
                color: selected ? '#ffffff' : color,
                weight: selected ? 3 : 2,
                fillColor: color,
                fillOpacity: closed ? 0.4 : 0.9,
            })
                .bindTooltip(`${PRIORITY_META[s.priority].label}: ${s.text.slice(0, 60)}`)
                .on('click', () => onSelectRef.current(s.id))
                .addTo(layer);
        }

        if (!fittedRef.current && located.length > 0) {
            fittedRef.current = true;
            const bounds = L.latLngBounds(located.map(s => [s.location!.latitude, s.location!.longitude]));
            map.fitBounds(bounds.pad(0.3), { maxZoom: 15 });
        }
    }, [sos, selectedId]);

    useEffect(() => {
        const s = sos.find(x => x.id === selectedId);
        if (s?.location && mapRef.current) {
            mapRef.current.flyTo([s.location.latitude, s.location.longitude],
                Math.max(mapRef.current.getZoom(), 14), { duration: 0.6 });
        }
        // Only when the selection changes, not on every list update.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId]);

    return <div ref={containerRef} className="h-full w-full rounded-2xl overflow-hidden" />;
}
