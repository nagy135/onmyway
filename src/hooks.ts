import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSnapshot } from '../shared/types';
import { api, ApiError, errorMessage } from './lib';
import { LocationTracker } from './location';

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
  const [status, setStatus] = useState<'locating' | 'active' | 'reconnecting' | 'paused' | 'error'>(enabled ? 'locating' : 'paused');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const deniedRef = useRef(false);
  const [message, setMessage] = useState('');
  const [syncError, setSyncError] = useState('');
  const [attempt, setAttempt] = useState(0);
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
    running.current = true; setStatus('locating'); setMessage('');
    const publish = () => {
      if (!running.current || inFlight.current || pausePending.current) return;
      const state = tracker.state;
      void update({ sharing: state.status !== 'denied', location: state.location });
    };
    const tracker = new LocationTracker(navigator.geolocation, (state) => {
      if (!alive) return;
      setStatus(state.status === 'denied' ? 'error' : state.status);
      setMessage(state.message);
      if (state.status === 'denied') {
        deniedRef.current = true; setPermissionDenied(true); setEnabled(false);
        // Permission revocation clears the last position after an in-flight fix.
        const removal = (inFlight.current ?? Promise.resolve()).then(() => update({ sharing: false, location: null }));
        pausePending.current = removal;
        void removal.finally(() => { if (pausePending.current === removal) pausePending.current = null; });
      } else publish();
    });
    tracker.start();
    const timer = setInterval(() => { tracker.tick(); publish(); }, 4000);
    const wake = () => {
      if (document.visibilityState === 'visible') { tracker.refresh(); publish(); }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    return () => {
      alive = false; running.current = false; clearInterval(timer); tracker.stop();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [id, viewerId, enabled, attempt, update]);

  useEffect(() => {
    if (!viewerId || !navigator.permissions) return;
    let alive = true;
    let permission: PermissionStatus | undefined;
    const granted = () => {
      if (!alive || permission?.state !== 'granted' || !deniedRef.current) return;
      // A permission change must not resume a meeting the user explicitly paused.
      try { if (sessionStorage.getItem(`onmyway-paused-${id}`) === '1') return; } catch { /* Storage is optional. */ }
      deniedRef.current = false; setPermissionDenied(false); setEnabled(true); setAttempt((value) => value + 1);
    };
    navigator.permissions.query({ name: 'geolocation' }).then((value) => {
      if (alive) {
        permission = value;
        permission.addEventListener('change', granted);
      }
    }).catch(() => { /* Some browsers do not expose geolocation permissions. */ });
    return () => { alive = false; permission?.removeEventListener('change', granted); };
  }, [id, viewerId]);

  async function pause() {
    running.current = false; deniedRef.current = false; setPermissionDenied(false); setEnabled(false); setStatus('paused'); setMessage('');
    try { sessionStorage.setItem(`onmyway-paused-${id}`, '1'); } catch { /* Storage is optional. */ }
    const removal = (inFlight.current ?? Promise.resolve()).then(() => update({ sharing: false, location: null }));
    pausePending.current = removal;
    await removal;
    if (pausePending.current === removal) pausePending.current = null;
  }

  function resume() { try { sessionStorage.removeItem(`onmyway-paused-${id}`); } catch { /* Storage is optional. */ } deniedRef.current = false; setPermissionDenied(false); setEnabled(true); setAttempt((value) => value + 1); }
  return { enabled, status, permissionDenied, message, syncError, pause, resume };
}
