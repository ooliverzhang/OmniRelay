import type { RateLimitDecision } from '@omni-relay/shared-types';

import type { RateLimitRepo } from '../contracts.js';
import { readChanges, readNumber, rowOf, type StorageDb } from '../db.js';

const DEFAULT_PRUNE_AGE_SECONDS = 24 * 60 * 60;

export function createRateLimitRepo(db: StorageDb): RateLimitRepo {
  return {
    consume(bucket, limit, now) {
      const nowMs = (now ?? db.now()).getTime();
      const windowSeconds =
        Number.isFinite(limit.windowSeconds) && limit.windowSeconds > 0
          ? Math.floor(limit.windowSeconds)
          : 60;
      const maxMessages =
        Number.isFinite(limit.maxMessages) && limit.maxMessages > 0
          ? Math.floor(limit.maxMessages)
          : 0;
      const windowMs = windowSeconds * 1000;
      const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
      const bucketKey = `${bucket.scope}:${bucket.scopeId}`;

      return db.transaction((): RateLimitDecision => {
        const row = rowOf(
          db
            .statement('SELECT window_start_ms, count FROM rate_limit_buckets WHERE bucket_key = ?')
            .get(bucketKey),
        );
        const sameWindow = row !== null && readNumber(row, 'window_start_ms') === windowStartMs;
        const consumed = sameWindow ? readNumber(row, 'count') : 0;

        const allowed = consumed < maxMessages;
        // The counter never exceeds the limit: a rejected call must not keep
        // inflating the bucket, otherwise `remaining` would go negative.
        const nextCount = Math.min(consumed + 1, maxMessages);

        db.statement(
          `INSERT INTO rate_limit_buckets (bucket_key, scope, scope_id, window_start_ms, count)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(bucket_key) DO UPDATE SET
             scope = excluded.scope,
             scope_id = excluded.scope_id,
             window_start_ms = excluded.window_start_ms,
             count = excluded.count`,
        ).run(bucketKey, bucket.scope, bucket.scopeId, windowStartMs, nextCount);

        return {
          allowed,
          remaining: Math.max(0, maxMessages - nextCount),
          retryAfterMs: allowed ? 0 : Math.max(0, windowStartMs + windowMs - nowMs),
          limit: maxMessages,
          windowSeconds,
        };
      });
    },

    prune(olderThanSeconds, now) {
      const ageSeconds =
        olderThanSeconds !== undefined && Number.isFinite(olderThanSeconds)
          ? Math.max(0, Math.floor(olderThanSeconds))
          : DEFAULT_PRUNE_AGE_SECONDS;
      const cutoffMs = (now ?? db.now()).getTime() - ageSeconds * 1000;
      return readChanges(
        db.statement('DELETE FROM rate_limit_buckets WHERE window_start_ms < ?').run(cutoffMs),
      );
    },
  };
}
