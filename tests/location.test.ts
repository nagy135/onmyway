import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_LOCATION_MS, LocationTracker, type TrackingState } from '../src/location.js';

interface Acquisition {
  success: PositionCallback;
  error: PositionErrorCallback | null | undefined;
  options: PositionOptions | undefined;
}

class FakeGeolocation {
  watches: Acquisition[] = [];
  requests: Acquisition[] = [];
  cleared: number[] = [];
  watchPosition(success: PositionCallback, error?: PositionErrorCallback | null, options?: PositionOptions) {
    this.watches.push({ success, error, options }); return this.watches.length - 1;
  }
  clearWatch(id: number) { this.cleared.push(id); }
  getCurrentPosition(success: PositionCallback, error?: PositionErrorCallback | null, options?: PositionOptions) {
    this.requests.push({ success, error, options });
  }
}

const gpsError = (code: number) => ({ code, message: 'Simulated GPS error' }) as GeolocationPositionError;
const position = (timestamp: number, latitude = 52.52) => ({
  coords: { latitude, longitude: 13.4, accuracy: 8 }, timestamp,
}) as GeolocationPosition;

function setup() {
  let now = 1000000;
  const geo = new FakeGeolocation();
  const states: TrackingState[] = [];
  const tracker = new LocationTracker(geo, (state) => states.push(state), () => now);
  tracker.start();
  return { geo, states, tracker, now: () => now, advance: (ms: number) => { now += ms; tracker.tick(); } };
}

for (const [code, name] of [[2, 'unavailable signal'], [3, 'GPS timeout']] as const) {
  test(`${name} retains a recent fix and automatically recovers without permission being requested again`, () => {
    const { geo, tracker, now, advance } = setup();
    geo.watches[0].success(position(now()));
    const original = tracker.state.location;
    geo.watches[0].error!(gpsError(code));
    assert.equal(tracker.state.status, 'reconnecting');
    assert.deepEqual(tracker.state.location, original);
    assert.match(tracker.state.message, /retrying automatically/);
    assert.doesNotMatch(tracker.state.message, /permission|access is off/);
    advance(4000);
    assert.equal(geo.requests.length, 1);
    assert.equal(geo.requests[0].options?.enableHighAccuracy, false);
    geo.requests[0].success(position(now(), 52.521));
    assert.equal(tracker.state.status, 'active');
    assert.equal(tracker.state.location!.latitude, 52.521);
    assert.equal(tracker.state.location!.timestamp, now());
    assert.equal(tracker.state.message, '');
  });
}

test('a failed stationary refresh does not permanently stop sharing', () => {
  const { geo, tracker, now, advance } = setup();
  geo.watches[0].success(position(now()));
  advance(16000);
  assert.equal(geo.requests.length, 1);
  advance(20000);
  geo.requests[0].error!(gpsError(3));
  assert.equal(tracker.state.status, 'reconnecting');
  assert.notEqual(tracker.state.location, null);
  advance(4000);
  assert.equal(geo.requests.length, 2);
  geo.requests[1].success(position(now()));
  assert.equal(tracker.state.status, 'active');
});

test('actual permission denial clears the fix and stops automatic acquisitions', () => {
  const { geo, tracker, now, advance } = setup();
  geo.watches[0].success(position(now()));
  advance(16000);
  geo.watches[0].error!(gpsError(1));
  assert.equal(tracker.state.status, 'denied');
  assert.equal(tracker.state.location, null);
  assert.match(tracker.state.message, /Location access is off/);
  assert(geo.cleared.includes(0));
  // Neither a late fix nor a visibility event may bypass revoked permission.
  geo.requests[0].success(position(now()));
  advance(60000);
  tracker.refresh();
  assert.equal(tracker.state.status, 'denied');
  assert.equal(tracker.state.location, null);
  assert.equal(geo.requests.length, 1);
  assert.equal(geo.watches.length, 1);
});

test('a recent watch update wins over an overlapping request that times out', () => {
  const { geo, tracker, now, advance } = setup();
  geo.watches[0].success(position(now()));
  advance(16000);
  geo.watches[0].success(position(now(), 52.523));
  geo.requests[0].error!(gpsError(3));
  assert.equal(tracker.state.status, 'active');
  assert.equal(tracker.state.location!.latitude, 52.523);
});

test('returning to the page restarts acquisition and ignores callbacks from the suspended watch and request', () => {
  const { geo, tracker, now, advance } = setup();
  advance(16000);
  assert.equal(geo.requests.length, 1);
  tracker.refresh();
  assert.equal(geo.watches.length, 2);
  assert.equal(geo.requests.length, 2);
  assert(geo.cleared.includes(0));
  geo.requests[0].success(position(now(), 60));
  geo.watches[0].success(position(now(), 70));
  assert.equal(tracker.state.location, null);
  geo.requests[1].success(position(now(), 52.521));
  assert.equal(tracker.state.status, 'active');
  assert.equal(tracker.state.location!.latitude, 52.521);
  // Focus and visibility events often arrive together; they share a restart.
  tracker.refresh();
  assert.equal(geo.watches.length, 2);
});

test('a request whose callback never arrives cannot block all future retries', () => {
  const { geo, tracker, now, advance } = setup();
  advance(16000);
  advance(30000);
  assert.equal(geo.requests.length, 2);
  geo.requests[0].success(position(now(), 60));
  assert.equal(tracker.state.location, null);
  geo.requests[1].success(position(now()));
  assert.equal(tracker.state.status, 'active');
});

test('retries never extend the timestamp of a stale position', () => {
  const { geo, tracker, now, advance } = setup();
  const initialTime = now();
  geo.watches[0].success(position(initialTime));
  geo.watches[0].error!(gpsError(3));
  advance(4000);
  assert.equal(tracker.state.location!.timestamp, initialTime);
  advance(FRESH_LOCATION_MS);
  assert.equal(tracker.state.location, null);
  assert.equal(tracker.state.status, 'reconnecting');
  geo.requests.at(-1)!.success(position(initialTime));
  assert.equal(tracker.state.location, null);
});

test('repeated cached fixes cannot postpone getting a genuinely fresh stationary fix', () => {
  const { geo, tracker, now, advance } = setup();
  const cached = position(now());
  geo.watches[0].success(cached);
  advance(8000);
  geo.watches[0].success(cached);
  advance(8000);
  assert.equal(geo.requests.length, 1);
});

test('pause or unmount stops the watch and ignores all pending callbacks', () => {
  const { geo, states, tracker, now, advance } = setup();
  advance(16000);
  tracker.stop();
  const changeCount = states.length;
  geo.requests[0].success(position(now()));
  geo.watches[0].success(position(now()));
  geo.watches[0].error!(gpsError(3));
  advance(60000);
  tracker.refresh();
  assert.equal(states.length, changeCount);
  assert.equal(geo.requests.length, 1);
  assert.equal(geo.watches.length, 1);
  assert(geo.cleared.includes(0));
});

test('permission denial delivered synchronously during wake-up cannot be overwritten by a retry', () => {
  const { geo, tracker, advance } = setup();
  advance(16000);
  geo.watchPosition = (_success, error) => { error!(gpsError(1)); return 99; };
  tracker.refresh();
  assert.equal(tracker.state.status, 'denied');
  assert.equal(tracker.state.location, null);
  assert.equal(geo.requests.length, 1);
  assert(geo.cleared.includes(99));
});
