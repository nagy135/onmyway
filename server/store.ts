import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Position, SessionSnapshot } from '../shared/types.js';

export const SESSION_TTL = 24 * 60 * 60 * 1000;
export const LOCATION_TTL = 2 * 60 * 1000;
export const ONLINE_TTL = 15 * 1000;
export const MAX_PARTICIPANTS = 12;

interface SessionRow { id: string; created_at: number; expires_at: number }
interface MemberRow {
  id: string; session_id: string; name: string; color: number; token_hash: string;
  sharing: number; last_seen: number; latitude: number | null; longitude: number | null;
  accuracy: number | null; location_at: number | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL, color INTEGER NOT NULL, token_hash TEXT NOT NULL,
        sharing INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL,
        latitude REAL, longitude REAL, accuracy REAL, location_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS participants_session ON participants(session_id);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    `);
  }

  session(id: string, now = Date.now()): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, now) as unknown as SessionRow | undefined;
  }

  create(name: string) {
    const id = randomBytes(16).toString('hex');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(id, now, now + SESSION_TTL);
      const member = this.join(id, name);
      this.db.exec('COMMIT');
      return { id, ...member };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  join(sessionId: string, name: string) {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM participants WHERE session_id = ?').get(sessionId) as { count: number };
    if (count.count >= MAX_PARTICIPANTS) throw new Error('SESSION_FULL');
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('hex');
    // Use a free color before recycling the palette.
    const colors = this.db.prepare('SELECT color FROM participants WHERE session_id = ?').all(sessionId) as { color: number }[];
    const color = Array.from({ length: 6 }, (_, i) => i).find((i) => !colors.some((p) => p.color === i)) ?? count.count % 6;
    this.db.prepare('INSERT INTO participants (id, session_id, name, color, token_hash, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, name, color, this.hash(token), Date.now());
    return { participantId: id, token };
  }

  hash(token: string) { return createHash('sha256').update(token).digest('hex'); }

  authenticate(sessionId: string, token?: string): MemberRow | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.db.prepare('SELECT * FROM participants WHERE session_id = ? AND token_hash = ?')
      .get(sessionId, this.hash(token)) as unknown as MemberRow | undefined;
  }

  update(id: string, input: { name?: string; sharing?: boolean; location?: Position | null }) {
    this.db.prepare('UPDATE participants SET last_seen = ? WHERE id = ?').run(Date.now(), id);
    if (input.name !== undefined) this.db.prepare('UPDATE participants SET name = ? WHERE id = ?').run(input.name, id);
    if (input.sharing !== undefined) this.db.prepare('UPDATE participants SET sharing = ? WHERE id = ?').run(input.sharing ? 1 : 0, id);
    if (input.sharing === false || input.location === null) {
      this.db.prepare('UPDATE participants SET latitude = NULL, longitude = NULL, accuracy = NULL, location_at = NULL WHERE id = ?').run(id);
    } else if (input.location) {
      const p = input.location;
      this.db.prepare('UPDATE participants SET sharing = 1, latitude = ?, longitude = ?, accuracy = ?, location_at = ? WHERE id = ?')
        .run(p.latitude, p.longitude, p.accuracy, p.timestamp, id);
    }
  }

  remove(id: string) { this.db.prepare('DELETE FROM participants WHERE id = ?').run(id); }

  snapshot(sessionId: string, viewerId: string | null, now = Date.now()): SessionSnapshot {
    const session = this.session(sessionId, now);
    if (!session) throw new Error('SESSION_EXPIRED');
    const rows = viewerId ? this.db.prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY rowid').all(sessionId) as unknown as MemberRow[] : [];
    return {
      id: session.id, createdAt: session.created_at, expiresAt: session.expires_at, viewerId,
      participants: rows.map((p) => ({
        id: p.id, name: p.name, color: p.color, sharing: Boolean(p.sharing),
        lastSeen: p.last_seen, online: now - p.last_seen < ONLINE_TTL,
        location: p.sharing && p.latitude !== null && p.longitude !== null && p.location_at !== null &&
          now - p.location_at < LOCATION_TTL && now - p.last_seen < LOCATION_TTL
          ? { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy ?? 0, timestamp: p.location_at } : null,
      })),
    };
  }

  cleanup(now = Date.now()) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('UPDATE participants SET latitude = NULL, longitude = NULL, accuracy = NULL, location_at = NULL WHERE location_at <= ? OR last_seen <= ?')
      .run(now - LOCATION_TTL, now - LOCATION_TTL);
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  close() { this.db.close(); }
}
