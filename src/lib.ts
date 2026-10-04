import type { Position } from '../shared/types';

export const COLORS = ['#35654d', '#c77a50', '#8173b5', '#478fa1', '#bb6581', '#a58939'];
export const INITIALS = (name: string) => Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', signal: AbortSignal.timeout(12000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(payload.error ?? 'Unable to connect. Please try again.', response.status);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function distanceBetween(a: Position, b: Position): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

export function formatDistance(meters: number) {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function directionsUrl(position: Position, provider: 'google' | 'apple' = 'google') {
  const destination = `${position.latitude},${position.longitude}`;
  return provider === 'apple'
    ? `https://maps.apple.com/?daddr=${encodeURIComponent(destination)}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=walking`;
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : 'Couldn’t connect. Check your connection and try again.';
}
