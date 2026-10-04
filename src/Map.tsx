import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LocateFixed, Maximize, Minus, Plus } from 'lucide-react';
import type { MapConfig, Participant } from '../shared/types';
import { api, COLORS, INITIALS } from './lib';

interface Props {
  participants: Participant[];
  viewerId?: string | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  preview?: boolean;
}

const DEFAULT_CONFIG: MapConfig = {
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  maxZoom: 19,
};

export function MeetingMap({ participants, viewerId, selectedId, onSelect, preview = false }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, { marker: L.Marker; label: string }>());
  const line = useRef<L.Polyline | null>(null);
  const accuracy = useRef<L.Circle | null>(null);
  const selectionRef = useRef(onSelect); selectionRef.current = onSelect;
  const participantsRef = useRef(participants); participantsRef.current = participants;
  const fittedIds = useRef('');
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [tileRetry, setTileRetry] = useState(0);

  const fit = () => {
    const points = participantsRef.current.flatMap((p) => p.location ? [L.latLng(p.location.latitude, p.location.longitude)] : []);
    if (points.length && map.current) map.current.fitBounds(L.latLngBounds(points), { padding: [80, 90], maxZoom: 16, animate: true });
  };

  useEffect(() => {
    let alive = true;
    const instance = L.map(element.current!, { zoomControl: false, scrollWheelZoom: !preview }).setView([52.5207, 13.399], preview ? 15 : 12);
    instance.attributionControl.setPrefix(false);
    map.current = instance;
    api<MapConfig>('/config').catch(() => DEFAULT_CONFIG).then((config) => {
      if (!alive) return;
      const tiles = L.tileLayer(config.tileUrl, { attribution: config.attribution, maxZoom: config.maxZoom, crossOrigin: false });
      tiles.on('tileerror', () => { if (alive) setTileError(true); });
      tiles.addTo(instance); setReady(true);
    });
    const resize = new ResizeObserver(() => instance.invalidateSize());
    resize.observe(element.current!);
    return () => {
      alive = false; resize.disconnect(); instance.remove(); map.current = null;
      markers.current.clear(); line.current = null; accuracy.current = null; fittedIds.current = ''; setReady(false);
    };
  }, [preview, tileRetry]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;
    const visible = participants.filter((p) => p.location);
    const ids = new Set(visible.map((p) => p.id));
    for (const [id, entry] of markers.current) if (!ids.has(id)) { entry.marker.remove(); markers.current.delete(id); }
    for (const person of visible) {
      const point: L.LatLngTuple = [person.location!.latitude, person.location!.longitude];
      const isYou = person.id === viewerId;
      const label = `${person.name}|${isYou}|${person.color}|${person.id === selectedId}`;
      let entry = markers.current.get(person.id);
      if (!entry) {
        const marker = L.marker(point, { keyboard: true, title: isYou ? `${person.name} (you)` : person.name, alt: person.name, zIndexOffset: isYou ? 200 : 100 });
        marker.on('click', () => selectionRef.current?.(person.id));
        entry = { marker, label: '' }; markers.current.set(person.id, entry);
      }
      if (entry.label !== label) {
        // User names are assigned through textContent, never interpolated into HTML.
        const wrapper = document.createElement('div');
        wrapper.className = `person-pin ${isYou ? 'person-pin-you' : ''} ${person.id === selectedId ? 'person-pin-selected' : ''}`;
        wrapper.style.setProperty('--person-color', COLORS[person.color % COLORS.length]);
        const avatar = document.createElement('span'); avatar.className = 'pin-avatar'; avatar.textContent = isYou ? '↑' : INITIALS(person.name);
        const tag = document.createElement('span'); tag.className = 'pin-label'; tag.textContent = isYou ? 'You' : person.name;
        wrapper.append(avatar, tag);
        entry.marker.setIcon(L.divIcon({ className: 'custom-marker', html: wrapper, iconSize: [48, 48], iconAnchor: [24, 24] }));
        entry.label = label;
      }
      entry.marker.setLatLng(point);
      if (!instance.hasLayer(entry.marker)) entry.marker.addTo(instance);
    }
    const idsKey = [...ids].sort().join(',');
    if (idsKey && idsKey !== fittedIds.current) { fit(); fittedIds.current = idsKey; }
    if (!idsKey) fittedIds.current = '';
    const self = visible.find((p) => p.id === viewerId);
    accuracy.current?.remove(); accuracy.current = null;
    if (self?.location && self.location.accuracy < 5000) accuracy.current = L.circle([self.location.latitude, self.location.longitude], {
      radius: Math.max(self.location.accuracy, 10), color: '#35654d', weight: 1, fillOpacity: 0.06, opacity: 0.2, interactive: false,
    }).addTo(instance);
    line.current?.remove(); line.current = null;
    const target = visible.find((p) => p.id === selectedId && p.id !== viewerId) ?? (preview ? visible.find((p) => p.id !== viewerId) : undefined);
    if (self?.location && target?.location) line.current = L.polyline([
      [self.location.latitude, self.location.longitude], [target.location.latitude, target.location.longitude],
    ], { color: '#426851', weight: 2, dashArray: '5 9', opacity: 0.6, interactive: false }).addTo(instance);
  }, [participants, viewerId, selectedId, ready, preview]);

  useEffect(() => {
    const target = participantsRef.current.find((p) => p.id === selectedId);
    if (target?.location) map.current?.panTo([target.location.latitude, target.location.longitude], { animate: true });
  }, [selectedId]);

  return <div className={`map-shell ${preview ? 'map-preview' : ''}`}>
    <div ref={element} className="leaflet-map" aria-label={preview ? 'Example meeting map in Berlin' : 'Live map of meeting participants'} />
    {tileError && <div className="map-error" role="status">Map tiles couldn’t load. <button onClick={() => { setTileError(false); setTileRetry((v) => v + 1); }}>Retry</button></div>}
    {!preview && <div className="map-controls">
      <button title="Show everyone" aria-label="Show everyone on the map" onClick={fit}><Maximize size={19} /></button>
      <button title="My location" aria-label="Center on my location" disabled={!participants.some((p) => p.id === viewerId && p.location)} onClick={() => {
        const self = participants.find((p) => p.id === viewerId);
        if (self?.location) map.current?.setView([self.location.latitude, self.location.longitude], 16, { animate: true });
      }}><LocateFixed size={20} /></button>
      <div className="control-divider" />
      <button aria-label="Zoom in" onClick={() => map.current?.zoomIn()}><Plus size={20} /></button>
      <button aria-label="Zoom out" onClick={() => map.current?.zoomOut()}><Minus size={20} /></button>
    </div>}
  </div>;
}
