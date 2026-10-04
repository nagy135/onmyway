import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';
import { MAX_PARTICIPANTS } from '../server/store.js';
import type { SessionSnapshot } from '../shared/types.js';

let runtime: ReturnType<typeof createApp>;
let server: Server;
let base: string;

before(async () => {
  runtime = createApp({ databasePath: ':memory:', rateLimits: false });
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  runtime.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function request(path: string, method = 'GET', body?: unknown, cookie?: string) {
  return fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function create(name = 'Alex') {
  const response = await request('/sessions', 'POST', { name });
  assert.equal(response.status, 201);
  const snapshot = await response.json() as SessionSnapshot;
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  return { snapshot, cookie };
}

test('session creation trims names and issues a private HttpOnly credential', async () => {
  const response = await request('/sessions', 'POST', { name: '  Alex  ' });
  const snapshot = await response.json() as SessionSnapshot;
  assert.equal(response.status, 201);
  assert.match(snapshot.id, /^[a-f0-9]{32}$/);
  assert.equal(snapshot.participants[0].name, 'Alex');
  assert.equal(snapshot.viewerId, snapshot.participants[0].id);
  assert.equal(snapshot.expiresAt - snapshot.createdAt, 86400000);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(response.headers.get('set-cookie')!, /SameSite=Lax/);
  assert.match(response.headers.get('set-cookie')!, new RegExp(`Path=/api/sessions/${snapshot.id}`));
  assert.equal('token_hash' in snapshot.participants[0], false);
  assert.equal('token' in snapshot, false);
});

test('joining shares the latest position with both participants and resuming keeps the same identity', async () => {
  const { snapshot, cookie } = await create();
  const joinResponse = await request(`/sessions/${snapshot.id}/join`, 'POST', { name: 'Sam' });
  const second = await joinResponse.json() as SessionSnapshot;
  const secondCookie = joinResponse.headers.get('set-cookie')!.split(';')[0];
  assert.equal(second.participants.length, 2);
  assert.notEqual(second.viewerId, snapshot.viewerId);
  assert.notEqual(second.participants[0].color, second.participants[1].color);
  const position = { latitude: 52.52, longitude: 13.4, accuracy: 8, timestamp: Date.now() };
  const updated = await request(`/sessions/${snapshot.id}/me`, 'PATCH', { sharing: true, location: position }, cookie);
  assert.equal(updated.status, 200);
  const otherView = await (await request(`/sessions/${snapshot.id}`, 'GET', undefined, secondCookie)).json() as SessionSnapshot;
  assert.deepEqual(otherView.participants[0].location, position);
  assert.equal(otherView.viewerId, second.viewerId);
  const rejoin = await request(`/sessions/${snapshot.id}/join`, 'POST', { name: 'Samuel' }, secondCookie);
  const resumed = await rejoin.json() as SessionSnapshot;
  assert.equal(resumed.viewerId, second.viewerId);
  assert.equal(resumed.participants.length, 2);
  assert.equal(resumed.participants[1].name, 'Samuel');
});

test('an invitation alone never exposes participant names or coordinates', async () => {
  const { snapshot, cookie } = await create('Private name');
  await request(`/sessions/${snapshot.id}/me`, 'PATCH', { location: { latitude: 52.52, longitude: 13.4, accuracy: 8, timestamp: Date.now() } }, cookie);
  const publicView = await (await request(`/sessions/${snapshot.id}`)).json() as SessionSnapshot;
  assert.equal(publicView.viewerId, null);
  assert.deepEqual(publicView.participants, []);
  assert.equal((await request(`/sessions/${snapshot.id}/me`, 'PATCH', { sharing: false })).status, 401);
  assert.equal((await request(`/sessions/${snapshot.id}/events`)).status, 401);
  assert.equal((await request(`/sessions/${snapshot.id}/me`, 'DELETE')).status, 401);
  const different = await create('Someone else');
  assert.equal((await request(`/sessions/${snapshot.id}/me`, 'PATCH', { sharing: false }, different.cookie)).status, 401);
});

test('pausing clears coordinates and leaving removes the participant and their credential', async () => {
  const { snapshot, cookie } = await create();
  const path = `/sessions/${snapshot.id}/me`;
  await request(path, 'PATCH', { location: { latitude: 0, longitude: 0, accuracy: 0, timestamp: Date.now() } }, cookie);
  const paused = await (await request(path, 'PATCH', { sharing: false }, cookie)).json() as SessionSnapshot;
  assert.equal(paused.participants[0].sharing, false);
  assert.equal(paused.participants[0].location, null);
  const row = runtime.store.db.prepare('SELECT latitude, longitude, location_at FROM participants WHERE id = ?').get(snapshot.viewerId!);
  assert.deepEqual({ ...row }, { latitude: null, longitude: null, location_at: null });
  const left = await request(path, 'DELETE', undefined, cookie);
  assert.equal(left.status, 204);
  assert.match(left.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
  assert.equal((await request(path, 'PATCH', {}, cookie)).status, 401);
  assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM participants WHERE session_id = ?').get(snapshot.id)!.count, 0);
});

test('invalid coordinates, old fixes, contradictory sharing state, and unknown fields are rejected', async () => {
  const { snapshot, cookie } = await create();
  const position = { latitude: 52.52, longitude: 13.4, accuracy: 8, timestamp: Date.now() };
  for (const body of [
    { location: { ...position, latitude: 91 } }, { location: { ...position, longitude: -181 } },
    { location: { ...position, accuracy: -1 } }, { location: { ...position, timestamp: Date.now() - 180000 } },
    { location: { ...position, timestamp: Date.now() + 60000 } }, { location: position, sharing: false },
    { name: '' }, { name: 'x'.repeat(41) }, { participantId: 'not-me', name: 'Attack' },
  ]) assert.equal((await request(`/sessions/${snapshot.id}/me`, 'PATCH', body, cookie)).status, 400);
  assert.equal((await request('/sessions', 'POST', { name: '   ' })).status, 400);
  const invalid = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'Invalid request body.');
});

test('cross-site mutations are blocked and JSON is required', async () => {
  const response = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'Intruder' }) });
  assert.equal(response.status, 403);
  const crossSite = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ name: 'Intruder' }) });
  assert.equal(crossSite.status, 403);
  const plain = await fetch(`${base}/api/sessions`, { method: 'POST', body: 'name=Alex' });
  assert.equal(plain.status, 415);
});

test('session capacity is enforced and a vacated spot can be used again', async () => {
  const { snapshot, cookie } = await create();
  for (let i = 1; i < MAX_PARTICIPANTS; i++) assert.equal((await request(`/sessions/${snapshot.id}/join`, 'POST', { name: `Friend ${i}` })).status, 201);
  assert.equal((await request(`/sessions/${snapshot.id}/join`, 'POST', { name: 'Too many' })).status, 409);
  await request(`/sessions/${snapshot.id}/me`, 'DELETE', undefined, cookie);
  assert.equal((await request(`/sessions/${snapshot.id}/join`, 'POST', { name: 'New friend' })).status, 201);
});

test('expired sessions cannot be read or joined, and cleanup cascades to participants', async () => {
  const { snapshot, cookie } = await create();
  runtime.store.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, snapshot.id);
  assert.equal((await request(`/sessions/${snapshot.id}`, 'GET', undefined, cookie)).status, 404);
  assert.equal((await request(`/sessions/${snapshot.id}/join`, 'POST', { name: 'Late friend' })).status, 404);
  assert.equal((await request('/sessions/not-a-session')).status, 404);
  runtime.store.cleanup();
  assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM participants WHERE session_id = ?').get(snapshot.id)!.count, 0);
});

test('SSE sends authorized snapshots and broadcasts a new participant and position', async () => {
  const { snapshot, cookie } = await create();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/sessions/${snapshot.id}/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader();
  let buffer = '';
  async function readUntil(predicate: (snapshot: SessionSnapshot) => boolean): Promise<SessionSnapshot> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop()!;
      for (const block of blocks) {
        if (!block.startsWith('event: snapshot')) continue;
        const value = JSON.parse(block.split('data: ')[1]) as SessionSnapshot;
        if (predicate(value)) return value;
      }
      const chunk = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('SSE update timed out')), 5000); timer.unref(); })]);
      if (chunk.done) throw new Error('SSE stream ended early');
      buffer += new TextDecoder().decode(chunk.value);
    }
    throw new Error('No matching SSE update');
  }
  try {
    assert.equal((await readUntil((value) => value.participants.length === 1)).viewerId, snapshot.viewerId);
    const join = await request(`/sessions/${snapshot.id}/join`, 'POST', { name: 'Sam' });
    const secondCookie = join.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await readUntil((value) => value.participants.length === 2)).participants[1].name, 'Sam');
    const position = { latitude: 52.521, longitude: 13.401, accuracy: 5, timestamp: Date.now() };
    await request(`/sessions/${snapshot.id}/me`, 'PATCH', { location: position }, secondCookie);
    assert.deepEqual((await readUntil((value) => value.participants[1]?.location !== null)).participants[1].location, position);
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
});
