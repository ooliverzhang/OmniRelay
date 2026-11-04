import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '@omni-relay/storage';

import { createStorage } from './helpers';

let storage: Storage;

beforeEach(() => {
  storage = createStorage();
});

afterEach(() => {
  storage.close();
});

describe('settings', () => {
  it('stores and reads JSON values', () => {
    storage.settings.set('string', 'value');
    storage.settings.set('number', 42);
    storage.settings.set('boolean', false);
    storage.settings.set('array', ['a', 'b']);
    storage.settings.set('object', { nested: { enabled: true } });

    expect(storage.settings.get<string>('string')).toBe('value');
    expect(storage.settings.get<number>('number')).toBe(42);
    expect(storage.settings.get<boolean>('boolean')).toBe(false);
    expect(storage.settings.get<string[]>('array')).toEqual(['a', 'b']);
    expect(storage.settings.get<{ nested: { enabled: boolean } }>('object')).toEqual({
      nested: { enabled: true },
    });
  });

  it('returns null for missing keys', () => {
    expect(storage.settings.get('missing')).toBeNull();
  });

  it('overwrites existing values', () => {
    storage.settings.set('key', 'first');
    storage.settings.set('key', 'second');
    expect(storage.settings.get('key')).toBe('second');
  });

  it('returns every setting as a plain object', () => {
    storage.settings.set('b', 2);
    storage.settings.set('a', 1);
    expect(storage.settings.all()).toEqual({ a: 1, b: 2 });
  });

  it('deletes settings', () => {
    storage.settings.set('key', 'value');
    expect(storage.settings.delete('key')).toBe(true);
    expect(storage.settings.delete('key')).toBe(false);
    expect(storage.settings.get('key')).toBeNull();
  });
});
