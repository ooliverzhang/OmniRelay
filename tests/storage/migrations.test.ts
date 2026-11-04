import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SCHEMA_VERSION, openStorage } from '@omni-relay/storage';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'omnirelay-storage-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('storage migrations', () => {
  it('applies the schema and can be run again safely', () => {
    const storage = openStorage({ sqlitePath: ':memory:' });

    expect(storage.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(() => storage.migrate()).not.toThrow();
    expect(storage.schemaVersion()).toBe(SCHEMA_VERSION);

    // Every repo is usable straight after migration.
    expect(storage.ids.count()).toBe(0);
    expect(storage.dedupe.size()).toBe(0);
    expect(storage.outbox.countByStatus()).toEqual({});
    expect(storage.attempts.count()).toBe(0);
    expect(storage.deadLetters.count()).toBe(0);
    expect(storage.rules.counts()).toEqual({ total: 0, enabled: 0 });
    expect(storage.settings.all()).toEqual({});
    expect(storage.messages.list({}).total).toBe(0);
    expect(storage.logs.list({}).total).toBe(0);

    storage.close();
  });

  it('is idempotent across reopen and keeps the data', () => {
    const directory = createTemporaryDirectory();
    const sqlitePath = join(directory, 'omni.db');

    const first = openStorage({ sqlitePath });
    first.settings.set('replyPolicy', { defaultMode: 'mention_only' });
    expect(first.schemaVersion()).toBe(SCHEMA_VERSION);
    first.close();

    const second = openStorage({ sqlitePath });
    expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(second.settings.get('replyPolicy')).toEqual({ defaultMode: 'mention_only' });
    second.migrate();
    expect(second.schemaVersion()).toBe(SCHEMA_VERSION);
    second.close();
  });

  it('creates missing parent directories for file databases', () => {
    const directory = createTemporaryDirectory();
    const sqlitePath = join(directory, 'nested', 'deeper', 'omni.db');

    const storage = openStorage({ sqlitePath });
    storage.settings.set('k', 'v');
    expect(existsSync(sqlitePath)).toBe(true);
    storage.close();
  });

  it('reports file size for paths and 0 for in-memory databases', () => {
    const directory = createTemporaryDirectory();
    const storage = openStorage({ sqlitePath: join(directory, 'size.db') });
    storage.logs.append({ level: 'info', msg: 'hello' });
    expect(storage.stats().sizeBytes).toBeGreaterThan(0);
    expect(storage.stats().schemaVersion).toBe(SCHEMA_VERSION);
    storage.close();

    const memory = openStorage({ sqlitePath: ':memory:' });
    expect(memory.stats()).toEqual({ sizeBytes: 0, schemaVersion: SCHEMA_VERSION });
    memory.close();
  });

  it('closes idempotently', () => {
    const storage = openStorage({ sqlitePath: ':memory:' });
    storage.close();
    expect(() => storage.close()).not.toThrow();
    expect(storage.schemaVersion()).toBe(SCHEMA_VERSION);
  });
});
