import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '@omni-relay/storage';

import { createClock, createStorage, type TestClock } from './helpers';

let storage: Storage;
let clock: TestClock;

beforeEach(() => {
  clock = createClock('2026-01-01T00:00:00.000Z');
  storage = createStorage(clock.now);
});

afterEach(() => {
  storage.close();
});

describe('inbound dedupe', () => {
  it('detects duplicates and expires entries by TTL', () => {
    expect(storage.dedupe.markSeen('key-1', { ttlSeconds: 60 })).toBe(true);
    expect(storage.dedupe.markSeen('key-1', { ttlSeconds: 60 })).toBe(false);
    expect(storage.dedupe.has('key-1')).toBe(true);
    expect(storage.dedupe.size()).toBe(1);
    expect(storage.dedupe.prune()).toBe(0);

    // One second after the TTL the key is new again.
    clock.advance(61_000);
    expect(storage.dedupe.has('key-1')).toBe(false);
    expect(storage.dedupe.markSeen('key-1', { ttlSeconds: 60 })).toBe(true);
    expect(storage.dedupe.size()).toBe(1);
  });

  it('honours an explicitly injected clock', () => {
    const explicit = new Date('2026-01-01T10:00:00.000Z');
    expect(storage.dedupe.markSeen('key-2', { ttlSeconds: 30, now: explicit })).toBe(true);
    expect(storage.dedupe.markSeen('key-2', { ttlSeconds: 30, now: explicit })).toBe(false);
    expect(
      storage.dedupe.markSeen('key-2', {
        ttlSeconds: 30,
        now: new Date(explicit.getTime() + 31_000),
      }),
    ).toBe(true);
  });

  it('prunes only expired entries', () => {
    storage.dedupe.markSeen('short', { ttlSeconds: 10 });
    clock.advance(20_000);
    storage.dedupe.markSeen('long', { ttlSeconds: 600 });

    expect(storage.dedupe.size()).toBe(2);
    expect(storage.dedupe.prune()).toBe(1);
    expect(storage.dedupe.size()).toBe(1);
    expect(storage.dedupe.has('long')).toBe(true);
  });

  it('uses a default TTL when none is provided', () => {
    expect(storage.dedupe.markSeen('key-3')).toBe(true);
    expect(storage.dedupe.markSeen('key-3')).toBe(false);
    clock.advance(3_599_000);
    expect(storage.dedupe.markSeen('key-3')).toBe(false);
    clock.advance(2_000);
    expect(storage.dedupe.markSeen('key-3')).toBe(true);
  });
});
