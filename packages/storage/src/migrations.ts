import { ONEBOT_ID_RANGES } from '@omni-relay/shared-types';
import type { DatabaseSync } from 'node:sqlite';

import type { StorageLogger } from './contracts.js';
import { readNumber, rowOf } from './db.js';

/**
 * Versioned, forward-only migrations.
 *
 * Each entry runs inside a single transaction together with its
 * `schema_migrations` row, so a failed migration leaves the database untouched.
 */
export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

const MIGRATION_1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS id_mappings (
    platform TEXT NOT NULL,
    native_kind TEXT NOT NULL,
    native_id TEXT NOT NULL,
    onebot_kind TEXT NOT NULL,
    onebot_id INTEGER NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (platform, native_kind, native_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_id_mappings_onebot
    ON id_mappings (onebot_kind, onebot_id)`,
  `CREATE TABLE IF NOT EXISTS id_allocator (
    onebot_kind TEXT PRIMARY KEY,
    next_id INTEGER NOT NULL
  )`,
  `INSERT OR IGNORE INTO id_allocator (onebot_kind, next_id) VALUES
    ('user', ${String(ONEBOT_ID_RANGES.user.min)}),
    ('group', ${String(ONEBOT_ID_RANGES.group.min)})`,
  `CREATE TABLE IF NOT EXISTS inbound_dedupe (
    dedupe_key TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inbound_dedupe_expires ON inbound_dedupe (expires_at)`,
  `CREATE TABLE IF NOT EXISTS outbox_messages (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    conversation_kind TEXT NOT NULL,
    conversation_native_id TEXT NOT NULL,
    sender_native_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at TEXT NOT NULL,
    last_error_json TEXT,
    rule_id TEXT,
    bridge_message_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox_messages (status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox_messages (created_at)`,
  `CREATE TABLE IF NOT EXISTS delivery_attempts (
    id TEXT PRIMARY KEY,
    outbox_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_delivery_attempts_outbox
    ON delivery_attempts (outbox_id, attempt)`,
  `CREATE TABLE IF NOT EXISTS dead_letters (
    id TEXT PRIMARY KEY,
    outbox_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    reason_message TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    conversation_kind TEXT NOT NULL,
    conversation_native_id TEXT NOT NULL,
    failed_at TEXT NOT NULL,
    attempts INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dead_letters_failed_at ON dead_letters (failed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_dead_letters_platform ON dead_letters (platform)`,
  `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    window_start_ms INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    platforms_json TEXT NOT NULL,
    conversation_kinds_json TEXT NOT NULL,
    group_ids_json TEXT NOT NULL,
    channel_ids_json TEXT NOT NULL,
    user_ids_json TEXT NOT NULL,
    trigger_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    rate_limit_json TEXT,
    schedule_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules (priority DESC, created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    bridge_message_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    conversation_kind TEXT NOT NULL,
    conversation_native_id TEXT NOT NULL,
    conversation_display_name TEXT,
    sender_native_id TEXT NOT NULL,
    sender_display_name TEXT,
    onebot_user_id INTEGER,
    onebot_group_id INTEGER,
    segments_json TEXT NOT NULL,
    segment_types_json TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    matched_rule_id TEXT,
    native_message_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages (platform, conversation_kind, conversation_native_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    time TEXT NOT NULL,
    level TEXT NOT NULL,
    msg TEXT NOT NULL,
    platform TEXT,
    event TEXT,
    context_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_time ON logs (time)`,
];

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', statements: MIGRATION_1 },
];

export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

function ensureMigrationTable(raw: DatabaseSync): void {
  raw.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );
}

/** Highest applied migration version; `0` before the first migration. */
export function schemaVersionOf(raw: DatabaseSync): number {
  try {
    const row = rowOf(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get());
    return row === null ? 0 : readNumber(row, 'version', 0);
  } catch {
    return 0;
  }
}

/** Applies every pending migration; safe to call repeatedly. */
export function migrateDatabase(
  raw: DatabaseSync,
  now: () => Date,
  logger?: StorageLogger | undefined,
): number {
  ensureMigrationTable(raw);
  const current = schemaVersionOf(raw);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    raw.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) {
        raw.exec(statement);
      }
      raw
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, now().toISOString());
      raw.exec('COMMIT');
      logger?.info('storage_migration_applied', {
        version: migration.version,
        name: migration.name,
      });
    } catch (error) {
      try {
        raw.exec('ROLLBACK');
      } catch {
        // Report the migration failure, not the rollback failure.
      }
      throw error;
    }
  }

  return schemaVersionOf(raw);
}
