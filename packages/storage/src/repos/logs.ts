import { randomUUID } from 'node:crypto';

import type { LogEntryInput, LogEntryRow, LogRepo } from '../contracts.js';
import { normalizePage } from '../contracts.js';
import {
  likeClause,
  likePattern,
  parseJsonOrNull,
  readChanges,
  readNumber,
  readNullableString,
  readString,
  rowOf,
  type SqlParam,
  type SqlRow,
  type StorageDb,
} from '../db.js';

/** Structured logs are kept in a ring buffer of this size. */
export const LOG_RETENTION_MAX_ROWS = 5000;

const COLUMNS = 'id, time, level, msg, platform, event, context_json';

function mapLog(row: SqlRow): LogEntryRow {
  return {
    id: readString(row, 'id'),
    time: readString(row, 'time'),
    level: readString(row, 'level'),
    msg: readString(row, 'msg'),
    platform: readNullableString(row, 'platform'),
    event: readNullableString(row, 'event'),
    context: parseJsonOrNull<Record<string, unknown>>(row.context_json),
  };
}

export function createLogRepo(db: StorageDb): LogRepo {
  const prune = (maxRows: number = LOG_RETENTION_MAX_ROWS): number => {
    const keep = Number.isFinite(maxRows)
      ? Math.max(0, Math.floor(maxRows))
      : LOG_RETENTION_MAX_ROWS;
    if (keep === 0) {
      return readChanges(db.statement('DELETE FROM logs').run());
    }
    return readChanges(
      db
        .statement(
          `DELETE FROM logs WHERE id NOT IN (
             SELECT id FROM logs ORDER BY time DESC, rowid DESC LIMIT ?
           )`,
        )
        .run(keep),
    );
  };

  return {
    append(entry: LogEntryInput): void {
      db.statement(
        `INSERT INTO logs (id, time, level, msg, platform, event, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `log_${randomUUID()}`,
        (entry.time ?? db.now()).toISOString(),
        entry.level,
        entry.msg,
        entry.platform ?? null,
        entry.event ?? null,
        entry.context === null || entry.context === undefined
          ? null
          : JSON.stringify(entry.context),
      );
      // Keep the ring buffer bounded without requiring an external scheduler.
      prune();
    },

    list(query) {
      const conditions: string[] = [];
      const params: SqlParam[] = [];
      if (query.level !== undefined) {
        conditions.push('level = ?');
        params.push(query.level);
      }
      if (query.platform !== undefined) {
        conditions.push('platform = ?');
        params.push(query.platform);
      }
      const search = query.search?.trim().slice(0, 200);
      if (search !== undefined && search.length > 0) {
        conditions.push(likeClause('msg'));
        params.push(likePattern(search));
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const { page, pageSize } = normalizePage(query);
      const totalRow = rowOf(
        db.statement(`SELECT COUNT(*) AS total FROM logs ${where}`).get(...params),
      );
      const rows = db
        .statement(
          `SELECT ${COLUMNS} FROM logs ${where}
           ORDER BY time DESC, rowid DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, (page - 1) * pageSize);
      return {
        items: rows.map((row) => mapLog(rowOf(row) as SqlRow)),
        total: totalRow === null ? 0 : readNumber(totalRow, 'total'),
      };
    },

    recentErrors(limit?: number): LogEntryRow[] {
      const requested = limit ?? 10;
      const safeLimit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 10;
      return db
        .statement(
          `SELECT ${COLUMNS} FROM logs
           WHERE level IN ('warn', 'error')
           ORDER BY time DESC, rowid DESC
           LIMIT ?`,
        )
        .all(safeLimit)
        .map((row) => mapLog(rowOf(row) as SqlRow));
    },

    prune,
  };
}
