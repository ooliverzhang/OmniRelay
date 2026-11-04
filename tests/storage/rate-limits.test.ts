import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '@omni-relay/storage';

import { createClock, createStorage, type TestClock } from './helpers';

let storage: Storage;
let clock: TestClock;

beforeEach(() => {
  clock = createClock('2026-01-01T06:00:00.000Z');
  storage = createStorage(clock.now);
});

afterEach(() => {
  storage.close();
});

const USER_BUCKET = { scope: 'user' as const, scopeId: 'user-1' };
const LIMIT = { maxMessages: 2, windowSeconds: 60 };

describe('rate limits', () => {
  it('allows up to the limit and then rejects', () => {
    const first = storage.rateLimits.consume(USER_BUCKET, LIMIT);
    expect(first).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
      limit: 2,
      windowSeconds: 60,
    });

    const second = storage.rateLimits.consume(USER_BUCKET, LIMIT);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);

    const third = storage.rateLimits.consume(USER_BUCKET, LIMIT);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.limit).toBe(2);
    expect(third.windowSeconds).toBe(60);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('never reports a negative remaining count', () => {
    for (let index = 0; index < 5; index += 1) {
      const decision = storage.rateLimits.consume(USER_BUCKET, LIMIT);
      expect(decision.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('recovers once the window slides', () => {
    storage.rateLimits.consume(USER_BUCKET, LIMIT);
    storage.rateLimits.consume(USER_BUCKET, LIMIT);
    expect(storage.rateLimits.consume(USER_BUCKET, LIMIT).allowed).toBe(false);

    clock.advance(60_000);
    const decision = storage.rateLimits.consume(USER_BUCKET, LIMIT);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(1);
  });

  it('keeps buckets independent per scope and scope id', () => {
    storage.rateLimits.consume(USER_BUCKET, LIMIT);
    storage.rateLimits.consume(USER_BUCKET, LIMIT);
    expect(storage.rateLimits.consume(USER_BUCKET, LIMIT).allowed).toBe(false);

    const otherUser = storage.rateLimits.consume({ scope: 'user', scopeId: 'user-2' }, LIMIT);
    expect(otherUser.allowed).toBe(true);

    const conversation = storage.rateLimits.consume(
      { scope: 'conversation', scopeId: 'discord:channel-1' },
      LIMIT,
    );
    expect(conversation.allowed).toBe(true);

    const globalScope = storage.rateLimits.consume({ scope: 'global', scopeId: 'global' }, LIMIT);
    expect(globalScope.allowed).toBe(true);
  });

  it('treats a limit of zero as always blocked', () => {
    const decision = storage.rateLimits.consume(USER_BUCKET, { maxMessages: 0, windowSeconds: 60 });
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.limit).toBe(0);
  });

  it('prunes stale buckets', () => {
    storage.rateLimits.consume(USER_BUCKET, LIMIT);
    expect(storage.rateLimits.prune(3600)).toBe(0);
    clock.advance(2 * 60 * 60 * 1000);
    expect(storage.rateLimits.prune(3600)).toBe(1);
  });
});
