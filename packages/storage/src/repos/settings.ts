import type { SettingsRepo } from '../contracts.js';
import { readChanges, readString, rowOf, type StorageDb } from '../db.js';

export function createSettingsRepo(db: StorageDb): SettingsRepo {
  const get = <T>(key: string): T | null => {
    const row = rowOf(db.statement('SELECT value_json FROM settings WHERE key = ?').get(key));
    if (row === null) {
      return null;
    }
    try {
      return JSON.parse(readString(row, 'value_json')) as T;
    } catch {
      return null;
    }
  };

  return {
    get,
    set(key: string, value: unknown): void {
      db.statement(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      ).run(key, JSON.stringify(value ?? null), db.now().toISOString());
    },
    all(): Record<string, unknown> {
      const rows = db.statement('SELECT key, value_json FROM settings ORDER BY key ASC').all();
      const result: Record<string, unknown> = {};
      for (const raw of rows) {
        const row = rowOf(raw);
        if (row === null) {
          continue;
        }
        const key = readString(row, 'key');
        try {
          result[key] = JSON.parse(readString(row, 'value_json')) as unknown;
        } catch {
          result[key] = null;
        }
      }
      return result;
    },
    delete(key: string): boolean {
      return readChanges(db.statement('DELETE FROM settings WHERE key = ?').run(key)) > 0;
    },
  };
}
