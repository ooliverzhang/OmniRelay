import type { DedupeRepo } from '../contracts.js';
import { readChanges, readNumber, readString, rowOf, type StorageDb } from '../db.js';

/** Inbound events are deduplicated for one hour unless the caller says otherwise. */
export const DEFAULT_DEDUPE_TTL_SECONDS = 3600;

function normalizeTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined || !Number.isFinite(ttlSeconds)) {
    return DEFAULT_DEDUPE_TTL_SECONDS;
  }
  return Math.max(0, Math.floor(ttlSeconds));
}

export function createDedupeRepo(db: StorageDb): DedupeRepo {
  return {
    markSeen(key, options) {
      const nowDate = options?.now ?? db.now();
      const nowIso = nowDate.toISOString();
      const ttlSeconds = normalizeTtl(options?.ttlSeconds);
      const expiresAt = new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString();

      return db.transaction(() => {
        const existing = rowOf(
          db.statement('SELECT expires_at FROM inbound_dedupe WHERE dedupe_key = ?').get(key),
        );
        if (existing !== null && readString(existing, 'expires_at') > nowIso) {
          return false;
        }
        db.statement(
          `INSERT INTO inbound_dedupe (dedupe_key, first_seen_at, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(dedupe_key) DO UPDATE SET
             first_seen_at = excluded.first_seen_at,
             expires_at = excluded.expires_at`,
        ).run(key, nowIso, expiresAt);
        return true;
      });
    },

    has(key: string): boolean {
      const row = rowOf(
        db
          .statement(
            'SELECT 1 AS present FROM inbound_dedupe WHERE dedupe_key = ? AND expires_at > ?',
          )
          .get(key, db.now().toISOString()),
      );
      return row !== null;
    },

    prune(now?: Date): number {
      const nowIso = (now ?? db.now()).toISOString();
      return readChanges(
        db.statement('DELETE FROM inbound_dedupe WHERE expires_at <= ?').run(nowIso),
      );
    },

    size(): number {
      const row = rowOf(db.statement('SELECT COUNT(*) AS total FROM inbound_dedupe').get());
      return row === null ? 0 : readNumber(row, 'total');
    },
  };
}
