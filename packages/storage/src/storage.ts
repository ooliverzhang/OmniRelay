import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { OpenStorageOptions, Storage } from './contracts.js';
import { isMemoryPath, openDatabase } from './db.js';
import { migrateDatabase, schemaVersionOf } from './migrations.js';
import { createDeliveryAttemptRepo } from './repos/attempts.js';
import { createDeadLetterRepo } from './repos/dead-letters.js';
import { createDedupeRepo } from './repos/dedupe.js';
import { createIdMappingRepo } from './repos/ids.js';
import { createLogRepo } from './repos/logs.js';
import { createMessageRepo } from './repos/messages.js';
import { createOutboxRepo } from './repos/outbox.js';
import { createRateLimitRepo } from './repos/rate-limits.js';
import { createRuleRepo } from './repos/rules.js';
import { createSettingsRepo } from './repos/settings.js';

/**
 * Opens the SQLite database, applies pending migrations and wires up every
 * repository behind the {@link Storage} facade.
 */
export function openStorage(options: OpenStorageOptions): Storage {
  const now = options.now ?? (() => new Date());
  const db = openDatabase({ sqlitePath: options.sqlitePath, now, logger: options.logger });

  let closed = false;
  let cachedVersion = 0;

  const migrate = (): void => {
    cachedVersion = migrateDatabase(db.raw, now, options.logger);
  };

  if (options.skipMigrate === true) {
    cachedVersion = schemaVersionOf(db.raw);
  } else {
    migrate();
  }

  const measureSizeBytes = (): number => {
    if (isMemoryPath(options.sqlitePath)) {
      return 0;
    }
    const absolute = resolve(options.sqlitePath);
    let size = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        size += statSync(`${absolute}${suffix}`).size;
      } catch {
        // The WAL/SHM sidecar may not exist yet.
      }
    }
    return size;
  };

  const currentSchemaVersion = (): number => {
    if (!closed) {
      cachedVersion = schemaVersionOf(db.raw);
    }
    return cachedVersion;
  };

  const storage: Storage = {
    ids: createIdMappingRepo(db),
    dedupe: createDedupeRepo(db),
    outbox: createOutboxRepo(db),
    attempts: createDeliveryAttemptRepo(db),
    deadLetters: createDeadLetterRepo(db),
    rateLimits: createRateLimitRepo(db),
    rules: createRuleRepo(db),
    settings: createSettingsRepo(db),
    messages: createMessageRepo(db),
    logs: createLogRepo(db),
    migrate,
    schemaVersion: currentSchemaVersion,
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    },
    stats() {
      return { sizeBytes: measureSizeBytes(), schemaVersion: currentSchemaVersion() };
    },
  };

  return storage;
}
