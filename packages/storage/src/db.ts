import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, StatementSync } from 'node:sqlite';

import type { StorageLogger } from './contracts.js';

/**
 * `node:sqlite` is a prefix-only builtin: some tooling (the Vite/vitest module
 * resolver used by the test runner) strips the `node:` prefix and then looks
 * for a package named `sqlite`, which fails. `process.getBuiltinModule` loads
 * the very same built-in driver synchronously and is immune to that rewrite.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

/** Row shape produced by the `node:sqlite` driver. */
export type SqlRow = Record<string, unknown>;

/** Parameter values accepted by prepared statements. */
export type SqlParam = string | number | null;

/**
 * Thin, synchronous wrapper around a single `DatabaseSync` connection.
 *
 * Every repo receives this handle: it owns the injected clock, the prepared
 * statement cache and nested-transaction bookkeeping so `BEGIN` is only ever
 * issued once.
 */
export interface StorageDb {
  readonly raw: SqliteDatabase;
  now(): Date;
  statement(sql: string): StatementSync;
  transaction<T>(callback: () => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  sqlitePath: string;
  now: () => Date;
  logger?: StorageLogger | undefined;
}

/** `:memory:` (and the empty path, which SQLite treats as a temporary db). */
export function isMemoryPath(sqlitePath: string): boolean {
  return sqlitePath === '' || sqlitePath === ':memory:';
}

export function openDatabase(options: OpenDatabaseOptions): StorageDb {
  const { sqlitePath, logger } = options;
  if (!isMemoryPath(sqlitePath)) {
    mkdirSync(dirname(resolve(sqlitePath)), { recursive: true });
  }

  const raw = new DatabaseSync(sqlitePath, {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });

  try {
    raw.exec('PRAGMA journal_mode = WAL');
  } catch (error) {
    // In-memory databases cannot use WAL; keep the default journal instead.
    logger?.debug('sqlite_wal_unavailable', { reason: describeError(error) });
  }
  try {
    raw.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    logger?.debug('sqlite_foreign_keys_unavailable', { reason: describeError(error) });
  }
  try {
    raw.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    logger?.debug('sqlite_busy_timeout_unavailable', { reason: describeError(error) });
  }

  const statements = new Map<string, StatementSync>();
  let depth = 0;
  let closed = false;

  const db: StorageDb = {
    raw,
    now: options.now,
    statement(sql: string): StatementSync {
      const cached = statements.get(sql);
      if (cached !== undefined) {
        return cached;
      }
      const prepared = raw.prepare(sql);
      statements.set(sql, prepared);
      return prepared;
    },
    transaction<T>(callback: () => T): T {
      if (depth > 0) {
        return callback();
      }
      depth += 1;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          // The transaction may already be gone; surface the original error.
        }
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      statements.clear();
      try {
        raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Nothing to flush for in-memory databases.
      }
      raw.close();
    },
  };

  return db;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// row helpers
// ---------------------------------------------------------------------------

export function rowOf(value: unknown): SqlRow | null {
  if (value === null || value === undefined || typeof value !== 'object') {
    return null;
  }
  return value as SqlRow;
}

export function readString(row: SqlRow, column: string, fallback = ''): string {
  const value = row[column];
  return typeof value === 'string' ? value : fallback;
}

export function readNullableString(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

export function readNumber(row: SqlRow, column: string, fallback = 0): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return fallback;
}

export function readNullableNumber(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return null;
}

export function readBoolean(row: SqlRow, column: string): boolean {
  return readNumber(row, column) !== 0;
}

export function readChanges(result: { changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonOrNull<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Builds a `%value%` LIKE pattern with `%`, `_` and `\` escaped. */
export function likePattern(value: string): string {
  const escaped = value.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

/** SQL fragment for a case-insensitive-ish LIKE match; bind `likePattern(...)`. */
export function likeClause(column: string): string {
  return `${column} LIKE ? ESCAPE '\\'`;
}
