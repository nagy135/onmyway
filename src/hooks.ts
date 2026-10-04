import { useCallback, useEffect, useRef, useState } from 'react';
import type { Position, SessionSnapshot } from '../shared/types';
import { api, ApiError, errorMessage } from './lib';

export function useSession(id: string) {
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setSession(null);
    api<SessionSnapshot>(`/sessions/${id}`).then((value) => { if (alive) setSession(value); })
      .catch((e) => { if (alive) setError(errorMessage(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id, retry]);

  const viewerId = session?.viewerId;
  useEffect(() => {
    if (!viewerId) return;
    let alive = true;
    const events = new EventSource(`/api/sessions/${id}/events`);
    events.onopen = () => { if (alive) setConnected(true); };
    events.onerror = () => { if (alive) setConnected(false); };
    events.addEventListener('snapshot', (event) => {
      if (alive) { setSession(JSON.parse((event as MessageEvent).data)); setConnected(true); }
    });
    events.addEventListener('expired', () => {
      events.close(); if (alive) { setConnected(false); setError('This meeting has expired. Start a new one to meet again.'); }
    });
    events.addEventListener('removed', () => {
      events.close(); if (alive) { setConnected(false); setSession((current) => current ? { ...current, viewerId: null, participants: [] } : current); }
    });
    // Also recover from expired authentication, server restarts, and a dropped stream.
    const poll = setInterval(() => {
      api<SessionSnapshot>(`/sessions/${id}`).then((value) => { if (alive) setSession(value); }).catch((e) => {
        if (alive && e instanceof ApiError && e.status === 404) { events.close(); setError(e.message); }
      });
    }, 15000);
    return () => { alive = false; clearInterval(poll); events.close(); setConnected(false); };
  }, [id, viewerId]);

  return { session, setSession, error, loading, connected, retry: () => setRetry((value) => value + 1) };
}

export function useLocation(id: string, viewerId: string | null, onSnapshot: (snapshot: SessionSnapshot) => void) {
  const [enabled, setEnabled] = useState(() => { try { return sessionStorage.getItem(`onmyway-paused-${id}`) !== '1'; } catch { return true; } });
  const [status, setStatus] = useState<'locating' | 'active' | 'paused' | 'error'>(enabled ? 'locating' : 'paused');
  const [message, setMessage] = useState('');
  const [syncError, setSyncError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const latest = useRef<Position | null>(null);
  const running = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const pausePending = useRef<Promise<void> | null>(null);

  const update = useCallback((body: unknown) => {
    const promise = api<SessionSnapshot>(`/sessions/${id}/me`, 'PATCH', body).then((snapshot) => {
      onSnapshotRef.current(snapshot); setSyncError('');
    }).catch((error) => { setSyncError(errorMessage(error)); });
    inFlight.current = promise;
    void promise.finally(() => { if (inFlight.current === promise) inFlight.current = null; });
    return promise;
  }, [id]);

  useEffect(() => {
    if (!viewerId) return;
    if (!enabled) {
      const timer = setInterval(() => { if (!inFlight.current && !pausePending.current) void update({ sharing: false }); }, 4000);
      return () => clearInterval(timer);
    }
    if (!window.isSecureContext || !navigator.geolocation) {
      setStatus('error'); setMessage('Location needs HTTPS (or localhost). Open this page using a secure connection.'); setEnabled(false); return;
    }
    let alive = true;
    running.current = true; latest.current = null; setStatus('locating'); setMessage('');
    const publish = () => {
      if (!running.current || inFlight.current || pausePending.current) return;
      const location = latest.current;
      const fresh = location && Date.now() - location.timestamp < 115000;
      void update(fresh ? { sharing: true, location } : { sharing: true, location: null });
    };
    const onPosition = (position: GeolocationPosition) => {
      if (!alive || !running.current) return;
      latest.current = {
        latitude: position.coords.latitude, longitude: position.coords.longitude,
        accuracy: position.coords.accuracy, timestamp: Math.min(position.timestamp, Date.now()),
      };
      setStatus('active'); setMessage(''); publish();
    };
    const onError = (error: GeolocationPositionError) => {
      if (!alive) return;
      latest.current = null; setStatus('error'); setEnabled(false);
      setMessage(error.code === 1 ? 'Location access is off. Allow location in your browser’s site settings, then try again.'
        : error.code === 2 ? 'Your position is unavailable. Turn on your device’s location services, then try again.'
          : 'Finding your location is taking a little longer. Try again outdoors or near a window.');
      // Queue the removal after any in-flight position so it cannot restore an old coordinate.
      const removal = (inFlight.current ?? Promise.resolve()).then(() => update({ sharing: false, location: null }));
      pausePending.current = removal;
      void removal.finally(() => { if (pausePending.current === removal) pausePending.current = null; });
    };
    const geoOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 };
    const watch = navigator.geolocation.watchPosition(onPosition, onError, geoOptions);
    let refreshing = false;
    const timer = setInterval(() => {
      publish();
      // Some devices stop firing watchPosition while stationary. Ask for a fresh
      // fix so an active, stationary person does not disappear after two minutes.
      if (latest.current && Date.now() - latest.current.timestamp > 10000 && !refreshing) {
        refreshing = true;
        navigator.geolocation.getCurrentPosition((position) => { refreshing = false; onPosition(position); }, (error) => {
          refreshing = false;
          if (!latest.current || Date.now() - latest.current.timestamp > 10000) onError(error);
        }, geoOptions);
      }
    }, 4000);
    publish();
    return () => { alive = false; running.current = false; clearInterval(timer); navigator.geolocation.clearWatch(watch); };
  }, [id, viewerId, enabled, attempt, update]);

  async function pause() {
    running.current = false; latest.current = null; setEnabled(false); setStatus('paused'); setMessage('');
    try { sessionStorage.setItem(`onmyway-paused-${id}`, '1'); } catch { /* Storage is optional. */ }
    const removal = (inFlight.current ?? Promise.resolve()).then(() => update({ sharing: false, location: null }));
    pausePending.current = removal;
    await removal;
    if (pausePending.current === removal) pausePending.current = null;
  }

  function resume() { try { sessionStorage.removeItem(`onmyway-paused-${id}`); } catch { /* Storage is optional. */ } setEnabled(true); setAttempt((value) => value + 1); }
  return { enabled, status, message, syncError, pause, resume };
}
