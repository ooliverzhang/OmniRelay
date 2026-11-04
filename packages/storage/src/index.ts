export * from './contracts.js';
export { openStorage } from './storage.js';
export { MIGRATIONS, SCHEMA_VERSION, migrateDatabase, schemaVersionOf } from './migrations.js';
export type { Migration } from './migrations.js';
export { DEFAULT_DEDUPE_TTL_SECONDS } from './repos/dedupe.js';
export { DEFAULT_MAX_ATTEMPTS } from './repos/outbox.js';
export { LOG_RETENTION_MAX_ROWS } from './repos/logs.js';
export { PRIORITY_STEP } from './repos/rules.js';

/** Package identifier, kept for diagnostics. */
export const packageName = '@omni-relay/storage' as const;
