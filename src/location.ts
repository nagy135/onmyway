import type { Position } from '../shared/types';

export type TrackingStatus = 'locating' | 'active' | 'reconnecting' | 'denied';
export interface TrackingState {
  status: TrackingStatus;
  location: Position | null;
  message: string;
}

// Leave a small margin before the server's two-minute expiry. Never refresh a
// position's timestamp just because we are still sending heartbeats.
export const FRESH_LOCATION_MS = 115000;
const FIX_INTERVAL_MS = 15000;
const REQUEST_TIMEOUT_MS = 20000;

/** Browser location acquisition, separate from network publishing and React. */
export class LocationTracker {
  private current: Position | null = null;
  private status: TrackingStatus = 'locating';
  private message = '';
  private stopped = true;
  private watchId: number | null = null;
  private watchGeneration = 0;
  private requestGeneration = 0;
  private pendingRequest = false;
  private requestedAt = 0;
  private nextFixAt = 0;
  private useCoarseLocation = false;
  private lastRefreshAt = -Infinity;

  constructor(
    private readonly geolocation: Pick<Geolocation, 'watchPosition' | 'clearWatch' | 'getCurrentPosition'>,
    private readonly onChange: (state: TrackingState) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): TrackingState {
    return {
      status: this.status,
      location: this.current && this.now() - this.current.timestamp < FRESH_LOCATION_MS ? this.current : null,
      message: this.message,
    };
  }

  start() {
    this.stopped = false;
    this.status = 'locating';
    this.message = '';
    this.nextFixAt = this.now() + FIX_INTERVAL_MS;
    this.emit();
    this.startWatch();
  }

  stop() {
    this.stopped = true;
    this.clearWatch();
    this.cancelRequest();
  }

  /** Called with the four-second heartbeat, including after suspended timers. */
  tick() {
    if (this.stopped || this.status === 'denied') return;
    if (this.current && this.now() - this.current.timestamp >= FRESH_LOCATION_MS) {
      this.current = null;
      this.reconnecting('Waiting for a fresh location. We’re retrying automatically.');
    } else if (this.status === 'active' && this.current && this.now() - this.current.timestamp > 30000) {
      this.reconnecting('Waiting for a fresh location. We’re retrying automatically.');
    }
    // A backgrounded browser may never finish its old request. Release that
    // request and ignore its late callbacks instead of blocking every retry.
    if (this.pendingRequest && this.now() - this.requestedAt > REQUEST_TIMEOUT_MS + 5000) {
      this.cancelRequest();
      this.nextFixAt = this.now();
      this.useCoarseLocation = true;
      this.reconnecting('Location updates were interrupted. We’re reconnecting automatically.');
    }
    if (!this.pendingRequest && this.now() >= this.nextFixAt) this.requestFix();
  }

  /** Re-establish a watch when returning to the page or regaining a network. */
  refresh() {
    if (this.stopped || this.status === 'denied' || this.now() - this.lastRefreshAt < 1000) return;
    this.lastRefreshAt = this.now();
    this.cancelRequest();
    this.startWatch();
    if (this.stopped || this.state.status === 'denied') return;
    if (!this.state.location) this.reconnecting('Finding your location again. We’re reconnecting automatically.');
    this.requestFix();
  }

  private emit() { this.onChange(this.state); }

  private clearWatch() {
    this.watchGeneration++;
    if (this.watchId !== null) this.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private cancelRequest() {
    this.requestGeneration++;
    this.pendingRequest = false;
  }

  private startWatch() {
    if (this.stopped) return;
    this.clearWatch();
    const generation = this.watchGeneration;
    const id = this.geolocation.watchPosition(
      (position) => { if (!this.stopped && generation === this.watchGeneration) this.receive(position); },
      (error) => { if (!this.stopped && generation === this.watchGeneration) this.fail(error); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: REQUEST_TIMEOUT_MS },
    );
    // Also tolerate implementations that invoke a callback synchronously.
    if (this.stopped || generation !== this.watchGeneration) this.geolocation.clearWatch(id);
    else this.watchId = id;
  }

  private requestFix() {
    if (this.stopped || this.status === 'denied') return;
    this.pendingRequest = true;
    this.requestedAt = this.now();
    this.nextFixAt = this.now() + FIX_INTERVAL_MS;
    const generation = ++this.requestGeneration;
    this.geolocation.getCurrentPosition((position) => {
      if (this.stopped || generation !== this.requestGeneration) return;
      this.pendingRequest = false;
      this.receive(position);
    }, (error) => {
      if (this.stopped || generation !== this.requestGeneration) return;
      this.pendingRequest = false;
      // A watch may have supplied a newer fix while this request was waiting.
      if (error.code === 1 || !this.current || this.now() - this.current.timestamp > FIX_INTERVAL_MS) this.fail(error);
    }, {
      // A network-based fix can recover when high-accuracy GPS cannot lock on.
      enableHighAccuracy: !this.useCoarseLocation, maximumAge: 5000, timeout: REQUEST_TIMEOUT_MS,
    });
  }

  private receive(position: GeolocationPosition) {
    if (this.status === 'denied') return;
    const timestamp = Math.min(position.timestamp, this.now());
    if (this.now() - timestamp >= FRESH_LOCATION_MS) {
      this.nextFixAt = this.now() + 4000;
      this.reconnecting('Waiting for a fresh location. We’re retrying automatically.');
      return;
    }
    if (this.current && timestamp < this.current.timestamp) return;
    this.current = {
      latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy: position.coords.accuracy, timestamp,
    };
    this.status = 'active';
    this.message = '';
    this.nextFixAt = timestamp + FIX_INTERVAL_MS;
    this.emit();
  }

  private fail(error: GeolocationPositionError) {
    if (error.code === 1) {
      this.current = null;
      this.status = 'denied';
      this.message = 'Location access is off. Allow location in your browser’s site settings, then try again.';
      this.clearWatch();
      this.cancelRequest();
      this.emit();
      return;
    }
    this.useCoarseLocation = true;
    this.nextFixAt = this.now() + 4000;
    this.reconnecting(error.code === 2
      ? 'Your location signal is temporarily unavailable. We’re retrying automatically.'
      : 'Location is taking longer to update. We’re retrying automatically.');
  }

  private reconnecting(message: string) {
    this.status = 'reconnecting';
    this.message = message;
    this.emit();
  }
}
