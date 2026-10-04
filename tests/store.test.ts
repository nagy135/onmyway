import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCATION_TTL, ONLINE_TTL, Store } from '../server/store.js';
import { directionsUrl, distanceBetween, formatDistance } from '../src/lib.js';

test('sessions, membership, and the latest position persist across restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'onmyway-test-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  try {
    const created = store.create('Alex');
    const location = { latitude: 52.52, longitude: 13.4, accuracy: 8, timestamp: Date.now() };
    store.update(created.participantId, { location });
    store.close(); store = new Store(path);
    assert.equal(store.authenticate(created.id, created.token)?.id, created.participantId);
    assert.deepEqual(store.snapshot(created.id, created.participantId).participants[0].location, location);
    assert.notEqual(store.db.prepare('SELECT token_hash FROM participants WHERE id = ?').get(created.participantId)!.token_hash, created.token);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('offline status and stale positions are separate, and stale coordinates are purged', () => {
  const store = new Store(':memory:');
  try {
    const created = store.create('Alex');
    const now = Date.now();
    store.update(created.participantId, { location: { latitude: 0, longitude: 0, accuracy: 10, timestamp: now } });
    assert.equal(store.snapshot(created.id, created.participantId, now + ONLINE_TTL + 1).participants[0].online, false);
    assert.notEqual(store.snapshot(created.id, created.participantId, now + ONLINE_TTL + 1).participants[0].location, null);
    assert.equal(store.snapshot(created.id, created.participantId, now + LOCATION_TTL + 1).participants[0].location, null);
    store.cleanup(now + LOCATION_TTL + 1);
    assert.equal(store.db.prepare('SELECT latitude FROM participants WHERE id = ?').get(created.participantId)!.latitude, null);
  } finally { store.close(); }
});

test('a heartbeat cannot keep an old GPS fix visible indefinitely', () => {
  const store = new Store(':memory:');
  try {
    const created = store.create('Alex');
    const now = Date.now();
    store.update(created.participantId, { location: { latitude: 10, longitude: 10, accuracy: 3, timestamp: now - LOCATION_TTL - 1 } });
    store.update(created.participantId, {});
    const person = store.snapshot(created.id, created.participantId, now).participants[0];
    assert.equal(person.online, true);
    assert.equal(person.location, null);
  } finally { store.close(); }
});

test('distances and external maps URLs handle zero and international coordinates', () => {
  const origin = { latitude: 0, longitude: 0, accuracy: 0, timestamp: 0 };
  assert.equal(distanceBetween(origin, origin), 0);
  const oneDegree = distanceBetween(origin, { ...origin, latitude: 1 });
  assert(Math.abs(oneDegree - 111195) < 1);
  assert.equal(formatDistance(240), '240 m');
  assert.equal(formatDistance(1540), '1.5 km');
  const position = { ...origin, latitude: -33.86, longitude: 151.21 };
  const google = new URL(directionsUrl(position));
  assert.equal(google.searchParams.get('destination'), '-33.86,151.21');
  assert.equal(google.searchParams.get('api'), '1');
  assert.equal(google.searchParams.get('travelmode'), 'walking');
  assert.equal(new URL(directionsUrl(position, 'apple')).searchParams.get('daddr'), '-33.86,151.21');
});
