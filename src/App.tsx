import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronLeft, Copy, ExternalLink, Footprints, Heart, Link, LoaderCircle, LocateFixed, LogOut, MapPin, Navigation, Pause, Play, Radio, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import type { Participant, SessionSnapshot } from '../shared/types';
import { MeetingMap } from './Map';
import { useLocation, useSession } from './hooks';
import { api, COLORS, directionsUrl, distanceBetween, errorMessage, formatDistance, INITIALS } from './lib';

const EXAMPLE_PEOPLE: Participant[] = [
  { id: 'you', name: 'You', color: 0, sharing: true, online: true, lastSeen: 0, location: { latitude: 52.51935, longitude: 13.3961, accuracy: 18, timestamp: 0 } },
  { id: 'alex', name: 'Alex', color: 1, sharing: true, online: true, lastSeen: 0, location: { latitude: 52.52315, longitude: 13.4018, accuracy: 10, timestamp: 0 } },
];

type InfoPanel = 'how' | 'privacy' | null;

function Brand({ onClick }: { onClick: () => void }) {
  return <button className="brand" onClick={onClick} aria-label="On My Way home"><span className="brand-mark"><Navigation size={24} strokeWidth={2.3} fill="currentColor" /></span><span>onmyway<span className="brand-period">.</span></span></button>;
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="dialog" onCancel={onClose} onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}

function InfoDialog({ panel, onClose }: { panel: Exclude<InfoPanel, null>; onClose: () => void }) {
  return <Dialog title={panel === 'how' ? 'A little less looking. A lot more meeting.' : 'Your location. Your choice.'} onClose={onClose}>
    {panel === 'how' ? <div className="info-content">
      <p>On My Way gives you and your people one shared map. No accounts, no app downloads, no back-and-forth.</p>
      <ol className="info-steps"><li><strong>Start a meeting.</strong> Enter your name and allow your browser to use your location.</li><li><strong>Send the link.</strong> Your friend joins with their name and location.</li><li><strong>Find each other.</strong> Tap a person to see their distance and open walking directions.</li></ol>
      <div className="info-note"><LocateFixed size={20} /><p>Keep this page open while you’re meeting. Positions update every four seconds when your device provides a fresh location. Phones may pause updates when locked or when the browser is in the background.</p></div>
      <p className="muted">Meetings last 24 hours and support up to 12 people. Distances on the map are straight-line estimates; your maps app finds the walking route.</p>
    </div> : <div className="info-content">
      <p>Your location is visible to people who join through your meeting link. Only share the link with people you want to meet.</p>
      <ul className="privacy-list"><li><ShieldCheck size={19} /><span><strong>No account needed.</strong> We store your chosen name and latest position for this meeting, without a movement history.</span></li><li><Pause size={19} /><span><strong>Pause whenever you like.</strong> Pausing removes your position. Leaving removes your name and position from the meeting.</span></li><li><Radio size={19} /><span><strong>Old positions disappear.</strong> A position is hidden after two minutes without a fresh update. Expired meetings are deleted automatically.</span></li></ul>
      <p className="muted">Map tiles come from OpenStreetMap (or the operator’s configured provider), which receives your IP address and the map area you view. Opening directions shares the selected destination with your chosen maps provider. No analytics or advertising trackers are included.</p>
    </div>}
    <button className="button button-primary dialog-done" onClick={onClose}>Got it <Check size={18} /></button>
  </Dialog>;
}

function NameForm({ join = false, edit = false, initialName, onSubmit }: { join?: boolean; edit?: boolean; initialName?: string; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(() => { if (initialName !== undefined) return initialName; try { return localStorage.getItem('onmyway-name') ?? ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      try { localStorage.setItem('onmyway-name', name.trim()); } catch { /* Private browsers may disable storage. */ }
      await onSubmit(name.trim());
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <form className="name-form" onSubmit={submit}>
    <label htmlFor="display-name">What should we call you?</label>
    <div className="name-input-wrap"><Users size={19} /><input id="display-name" name="name" placeholder="Your first name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} autoComplete="given-name" disabled={busy} /></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="button button-primary start-button" type="submit" disabled={busy || !name.trim()}>{busy ? <><LoaderCircle className="spin" size={19} /> Just a moment…</> : <>{edit ? 'Save your name' : join ? 'Join this meeting' : 'Start a meeting'}<ArrowUpRight size={21} /></>}</button>
    <p className="form-note"><ShieldCheck size={14} /> {edit ? 'Your people will see your new name.' : 'No signup. Just you and your people.'}</p>
  </form>;
}

function Landing({ navigate, setInfo }: { navigate: (path: string) => void; setInfo: (panel: InfoPanel) => void }) {
  return <>
    <main className="landing-main">
      <section className="hero-copy">
        <div className="eyebrow"><span className="small-dot" /> A LITTLE CLOSER, ALREADY</div>
        <h1>Find your people.<br /><span>Skip the search.</span></h1>
        <p className="hero-description">The “I’m by the thing, next to the other thing”<br className="desktop-break" /> era is over. Share a live map. Meet in the middle.</p>
        <div className="start-card"><div className="start-card-title"><span className="small-icon"><Navigation size={19} /></span><h2>Good things start with a hello.</h2></div>
          <NameForm onSubmit={async (name) => { const session = await api<SessionSnapshot>('/sessions', 'POST', { name }); navigate(`/s/${session.id}`); }} />
        </div>
        <div className="hero-benefits"><span><Radio size={15} /> Live location</span><span><Link size={15} /> One simple link</span><span><Heart size={15} /> Zero fuss</span></div>
      </section>
      <section className="hero-map-section" aria-label="Preview of a shared meeting map">
        <MeetingMap participants={EXAMPLE_PEOPLE} viewerId="you" preview />
        <div className="preview-badge"><span className="preview-badge-dot" /> A little preview</div>
        <div className="map-caption">Two people. One place to find each other.</div>
        <div className="preview-meeting-card"><div className="preview-avatars"><span className="avatar" style={{ background: COLORS[0] }}>Y</span><span className="avatar" style={{ background: COLORS[1] }}>A</span></div><div><strong>Better together.</strong><span>Your next hello is a little closer.</span></div><span className="preview-heart"><Heart size={19} /></span></div>
        <span className="map-corner-note"><Sparkles size={14} /> An example in Berlin</span>
      </section>
    </main>
    <section className="how-strip" aria-label="How it works"><div className="how-intro"><span className="eyebrow">LESS COORDINATING.</span><h2>More connecting.</h2></div>
      <div className="how-step"><span className="step-number">01</span><div><h3>Make it a meeting</h3><p>A name is all you need.</p></div></div><ArrowRight className="step-arrow" size={20} />
      <div className="how-step"><span className="step-number">02</span><div><h3>Pass the link along</h3><p>Your people are one tap away.</p></div></div><ArrowRight className="step-arrow" size={20} />
      <div className="how-step"><span className="step-number">03</span><div><h3>Find your way together</h3><p>Live dots. Real-life hellos.</p></div></div>
    </section>
    <footer className="footer"><span>A little less “where are you?” <span className="footer-arrow">↗</span> A little more “there you are.”</span><button onClick={() => setInfo('privacy')}><ShieldCheck size={15} /> Private by design</button></footer>
  </>;
}

function ShareCard({ id, showToast }: { id: string; showToast: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const link = `${window.location.origin}/s/${id}`;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 2500); return () => clearTimeout(timer); } }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); showToast('Meeting link copied. Send it to your people.'); }
    catch { input.current?.focus(); input.current?.select(); showToast('Select and copy the meeting link below.'); }
  }
  return <section className="panel share-panel"><div className="panel-icon"><Link size={20} /></div><h2>A link between you.</h2><p>Send this to the people you’re meeting.<br />They’ll appear right here.</p>
    <div className="share-link"><input ref={input} aria-label="Meeting invite link" value={link} readOnly onClick={(e) => e.currentTarget.select()} /><button className="icon-button" aria-label="Copy meeting link" onClick={copy}>{copied ? <Check size={18} /> : <Copy size={18} />}</button></div>
    <button className="button button-primary share-button" disabled={busy} onClick={async () => {
      if (!navigator.share) { await copy(); return; }
      setBusy(true);
      try { await navigator.share({ title: 'Meet me on On My Way', text: 'Let’s find each other. Join my live meeting map:', url: link }); }
      catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) await copy(); }
      finally { setBusy(false); }
    }}>{copied ? 'Link copied' : 'Share meeting link'}{copied ? <Check size={17} /> : <ArrowUpRight size={18} />}</button>
    <span className="share-note"><ShieldCheck size={13} /> Only invite people you trust.</span>
  </section>;
}

function Directions({ person }: { person: Participant }) {
  if (!person.location) return null;
  return <div className="directions-actions"><a className="button button-primary" href={directionsUrl(person.location)} target="_blank" rel="noopener noreferrer">Walk to {person.name}<ArrowUpRight size={18} /></a><a className="apple-link" href={directionsUrl(person.location, 'apple')} target="_blank" rel="noopener noreferrer">Open in Apple Maps <ExternalLink size={13} /></a></div>;
}

function Meeting({ id, navigate, showToast }: { id: string; navigate: (path: string) => void; showToast: (message: string) => void }) {
  const live = useSession(id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (live.loading) return <main className="center-state"><LoaderCircle className="spin" size={30} /><h1>Finding your meeting…</h1></main>;
  if (live.error) return <main className="center-state"><span className="state-icon"><MapPin size={29} /></span><h1>Let’s find a fresh start.</h1><p role="alert">{live.error}</p><div className="state-actions"><button className="button button-secondary" onClick={live.retry}>Try again</button><button className="button button-primary" onClick={() => navigate('/')}>Start a new meeting <ArrowRight size={18} /></button></div></main>;
  if (!live.session) return null;
  if (!live.session.viewerId) return <main className="join-page"><section className="join-card"><span className="join-illustration"><Users size={38} /><span className="hello-tag">hello!</span></span><div className="eyebrow">YOU’RE INVITED</div><h1>Your people<br /><span>are right here.</span></h1><p>You’ve got a place on the map. Add your name,<br />share your location, and find each other.</p><NameForm join onSubmit={async (name) => { live.setSession(await api<SessionSnapshot>(`/sessions/${id}/join`, 'POST', { name })); }} /><span className="join-expiry">This meeting expires {new Date(live.session.expiresAt).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })}.</span></section><button className="text-button" onClick={() => navigate('/')}><ChevronLeft size={16} /> Start your own meeting</button></main>;
  return <ActiveMeeting key={live.session.viewerId} session={live.session} connected={live.connected} onSnapshot={live.setSession} selectedId={selectedId} onSelect={setSelectedId} navigate={navigate} showToast={showToast} />;
}

function ActiveMeeting({ session, connected, onSnapshot, selectedId, onSelect, navigate, showToast }: {
  session: SessionSnapshot; connected: boolean; onSnapshot: (snapshot: SessionSnapshot) => void;
  selectedId: string | null; onSelect: (id: string | null) => void; navigate: (path: string) => void; showToast: (message: string) => void;
}) {
  const location = useLocation(session.id, session.viewerId, onSnapshot);
  const [editName, setEditName] = useState(false);
  const [leaveDialog, setLeaveDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const self = session.participants.find((p) => p.id === session.viewerId)!;
  const others = session.participants.filter((p) => p.id !== session.viewerId);
  const selected = others.find((p) => p.id === selectedId);
  const sharingLabel = location.status === 'active' ? 'Sharing your live location' : location.status === 'locating' ? 'Finding your location…' : location.status === 'paused' ? 'Your location is paused' : 'Location needs your attention';
  const mapsReady = session.participants.some((p) => p.location);
  const expiresIn = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 3600000));

  return <main className="meeting-main">
    <div className="meeting-heading"><div><button className="back-link" onClick={() => navigate('/')}><ChevronLeft size={14} /> Back home</button><h1>A little closer, together<span>.</span></h1><p>Your people, in real time. Let’s make that hello happen.</p></div><div className={`live-badge ${connected ? '' : 'connecting'}`}><span className="small-dot" /> {connected ? 'Live meeting' : 'Reconnecting…'}</div></div>
    <div className="meeting-grid">
      <section className="live-map-panel"><MeetingMap participants={session.participants} viewerId={session.viewerId} selectedId={selectedId} onSelect={onSelect} />
        <div className="map-top-label"><Users size={16} /> {session.participants.length} {session.participants.length === 1 ? 'person' : 'people'} in this meeting</div>
        {!mapsReady && <div className="map-empty"><span><LocateFixed size={26} /></span><strong>A hello starts here.</strong><p>{location.status === 'error' ? 'Allow location access to put yourself on the map.' : location.status === 'paused' ? 'Resume sharing to appear on the map.' : 'Your map will center as soon as a location is available.'}</p></div>}
        {selected?.location && <div className="map-person-card"><div className="map-person-heading"><span className="avatar" style={{ background: COLORS[selected.color] }}>{INITIALS(selected.name)}</span><div><strong>{selected.name}</strong><span>{self?.location ? `${formatDistance(distanceBetween(self.location, selected.location))} away · straight line` : 'Location is available'}</span></div><button className="icon-button" aria-label="Close person details" onClick={() => onSelect(null)}><X size={18} /></button></div><Directions person={selected} /></div>}
        <div className="map-bottom-note"><Radio size={13} /> Updates every 4 seconds <span>·</span> Keep this page open</div>
      </section>
      <aside className="meeting-sidebar">
        <ShareCard id={session.id} showToast={showToast} />
        <section className="panel people-panel"><div className="panel-heading"><h2>Who’s on the way</h2><span className="count-pill">{session.participants.length}</span></div>
          <div className="person-row self-row"><span className="avatar" style={{ background: COLORS[self?.color ?? 0] }}>{INITIALS(self?.name ?? 'You')}</span><div className="person-info"><button className="name-edit" onClick={() => setEditName(true)} title="Change your name">{self?.name} <span>(you)</span><ChevronDown size={13} /></button><span className={`person-status ${location.status === 'active' ? 'status-active' : ''}`}><span className="tiny-dot" />{location.status === 'active' ? 'Sharing location' : location.status === 'locating' ? 'Locating…' : location.status === 'paused' ? 'Location paused' : 'Location unavailable'}</span></div></div>
          {others.map((person) => <button key={person.id} className={`person-row person-select ${selectedId === person.id ? 'person-selected' : ''}`} onClick={() => onSelect(person.id)}>
            <span className="avatar" style={{ background: COLORS[person.color] }}>{INITIALS(person.name)}</span><span className="person-info"><strong>{person.name}</strong><span className="person-status"><span className={`tiny-dot ${person.online ? 'online-dot' : ''}`} />{!person.online ? 'Away · waiting for update' : !person.sharing ? 'Location paused' : !person.location ? 'Waiting for location' : self?.location ? `${formatDistance(distanceBetween(self.location, person.location))} away` : 'On the map'}</span></span><ArrowUpRight size={17} /></button>)}
          {others.length === 0 && <div className="waiting-people"><div className="waiting-avatar"><Users size={22} /></div><strong>Room for your people.</strong><p>Share the link. Their hello<br /> will show up here.</p></div>}
          {selected && !selected.location && <p className="person-unavailable" role="status">{selected.name}’s position is currently unavailable. Directions will appear when they share a fresh location.</p>}
        </section>
        <div className="expiry-note"><ShieldCheck size={15} /><span>A temporary map. A real connection.<br /><strong>Meeting expires in {expiresIn} {expiresIn === 1 ? 'hour' : 'hours'}.</strong></span></div>
      </aside>
    </div>
    <section className={`location-bar ${location.status === 'error' ? 'location-bar-error' : ''}`}><span className="location-bar-icon">{location.status === 'active' ? <Radio size={21} /> : location.status === 'paused' ? <Pause size={20} /> : <LocateFixed size={21} />}</span><div><strong>{sharingLabel}</strong><p>{location.message || (location.status === 'paused' ? 'Take a breather. You can still see your people.' : 'You’re in control. Pause or leave whenever you like.')}</p>{location.syncError && <p className="sync-error" role="alert">{location.syncError} Your last position may remain visible for up to two minutes.</p>}</div>
      <div className="location-actions"><button className="button button-secondary" disabled={busy} onClick={() => { if (location.enabled && location.status !== 'error') void location.pause(); else location.resume(); }}>{location.enabled && location.status !== 'error' ? <><Pause size={15} /> Pause sharing</> : <><Play size={15} /> {location.status === 'error' ? 'Try location again' : 'Resume sharing'}</>}</button><button className="leave-button" onClick={() => setLeaveDialog(true)}><LogOut size={16} /> Leave</button></div>
    </section>
    <div className="meeting-footnote"><Footprints size={15} /> Tap a person on the map to open walking directions.</div>
    {editName && <Dialog title="A name your people know." onClose={() => setEditName(false)}><NameForm edit initialName={self?.name} onSubmit={async (name) => { onSnapshot(await api<SessionSnapshot>(`/sessions/${session.id}/me`, 'PATCH', { name })); setEditName(false); showToast('Your name has been updated.'); }} /></Dialog>}
    {leaveDialog && <Dialog title="See you out there." onClose={() => { if (!busy) setLeaveDialog(false); }}><div className="info-content"><p>Leaving removes your name and location from this meeting. Your people can keep using the link, and you can join again later.</p></div><div className="dialog-actions"><button className="button button-secondary" disabled={busy} onClick={() => setLeaveDialog(false)}>Stay here</button><button className="button button-primary" disabled={busy} onClick={async () => { setBusy(true); await location.pause(); try { await api(`/sessions/${session.id}/me`, 'DELETE'); navigate('/'); showToast('You left the meeting. See you out there.'); } catch (error) { showToast(errorMessage(error)); setBusy(false); } }}>{busy ? <LoaderCircle size={17} className="spin" /> : <LogOut size={17} />} Leave meeting</button></div></Dialog>}
  </main>;
}

export function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [info, setInfo] = useState<InfoPanel>(null);
  const [toast, setToast] = useState('');
  useEffect(() => { const handler = () => setPath(window.location.pathname); window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); }, []);
  useEffect(() => { if (toast) { const timeout = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timeout); } }, [toast]);
  function navigate(next: string) { window.history.pushState({}, '', next); setPath(next); window.scrollTo(0, 0); }
  const sessionMatch = path.match(/^\/s\/([a-f0-9]{32})\/?$/);
  return <div className="app"><header className="header"><Brand onClick={() => navigate('/')} /><nav aria-label="Main navigation"><button onClick={() => setInfo('how')}>How it works</button><button onClick={() => setInfo('privacy')}>Your privacy</button><span className="header-tag"><span className="small-dot" /> Made for meeting</span></nav></header>
    {path === '/' ? <Landing navigate={navigate} setInfo={setInfo} /> : sessionMatch ? <Meeting key={sessionMatch[1]} id={sessionMatch[1]} navigate={navigate} showToast={setToast} /> : <main className="center-state"><MapPin size={32} /><h1>This path leads somewhere else.</h1><p>Check your meeting link, or start a fresh meeting.</p><button className="button button-primary" onClick={() => navigate('/')}>Back home <ArrowRight size={18} /></button></main>}
    {info && <InfoDialog panel={info} onClose={() => setInfo(null)} />}
    {toast && <div className="toast" role="status"><Check size={17} /> {toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={16} /></button></div>}
  </div>;
}
