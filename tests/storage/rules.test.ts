import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '@omni-relay/storage';
import { DEFAULT_RESPONSE_POLICY, type MessageRule } from '@omni-relay/shared-types';

import { createClock, createStorage, type TestClock } from './helpers';

let storage: Storage;
let clock: TestClock;

const CREATED_AT = '2026-01-01T00:00:00.000Z';

beforeEach(() => {
  clock = createClock(CREATED_AT);
  storage = createStorage(clock.now);
});

afterEach(() => {
  storage.close();
});

function makeRule(id: string, priority: number, overrides: Partial<MessageRule> = {}): MessageRule {
  return {
    id,
    name: `Rule ${id}`,
    enabled: true,
    priority,
    platforms: ['discord'],
    conversationKinds: ['group'],
    groupIds: [],
    channelIds: [],
    userIds: [],
    trigger: { requireMention: true },
    response: { ...DEFAULT_RESPONSE_POLICY },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe('rules', () => {
  it('creates and orders rules by priority then creation time', () => {
    storage.rules.create(makeRule('low', 10));
    storage.rules.create(makeRule('high', 30, { createdAt: '2026-01-01T00:02:00.000Z' }));
    storage.rules.create(makeRule('high-older', 30, { createdAt: '2026-01-01T00:01:00.000Z' }));

    expect(storage.rules.list().map((rule) => rule.id)).toEqual(['high-older', 'high', 'low']);
    expect(storage.rules.counts()).toEqual({ total: 3, enabled: 3 });
  });

  it('round-trips the full rule document', () => {
    const rule = makeRule('rule-1', 20, {
      platforms: ['discord', 'qq-official'],
      conversationKinds: ['private', 'group'],
      groupIds: ['g1'],
      channelIds: ['c1'],
      userIds: ['u1'],
      trigger: { requireMention: true, textIncludes: ['ping'], ignoreBots: false },
      response: { ...DEFAULT_RESPONSE_POLICY, maxResponseSegments: 2 },
      rateLimit: { maxMessages: 5, windowSeconds: 30, scope: 'user' },
      schedule: { timezone: 'Asia/Shanghai', weekdays: [1, 2, 3] },
    });
    storage.rules.create(rule);

    expect(storage.rules.get('rule-1')).toEqual(rule);
  });

  it('updates partial fields and clears optional documents', () => {
    storage.rules.create(
      makeRule('rule-1', 10, {
        rateLimit: { maxMessages: 5, windowSeconds: 30, scope: 'user' },
        schedule: { timezone: 'UTC' },
      }),
    );
    clock.advance(5_000);

    const updated = storage.rules.update('rule-1', {
      name: 'Renamed',
      enabled: false,
      response: { ...DEFAULT_RESPONSE_POLICY, maxResponseSegments: 4 },
    });

    expect(updated?.name).toBe('Renamed');
    expect(updated?.enabled).toBe(false);
    expect(updated?.response.maxResponseSegments).toBe(4);
    expect(updated?.rateLimit).toEqual({ maxMessages: 5, windowSeconds: 30, scope: 'user' });
    expect(updated?.updatedAt).toBe(clock.now().toISOString());
    expect(storage.rules.counts()).toEqual({ total: 1, enabled: 0 });

    const cleared = storage.rules.update('rule-1', { rateLimit: undefined, schedule: undefined });
    expect(cleared?.rateLimit).toBeUndefined();
    expect(cleared?.schedule).toBeUndefined();
    expect(storage.rules.get('rule-1')?.rateLimit).toBeUndefined();
  });

  it('returns null when updating an unknown rule', () => {
    expect(storage.rules.update('missing', { name: 'x' })).toBeNull();
  });

  it('removes rules', () => {
    storage.rules.create(makeRule('rule-1', 10));
    expect(storage.rules.remove('rule-1')).toBe(true);
    expect(storage.rules.remove('rule-1')).toBe(false);
    expect(storage.rules.get('rule-1')).toBeNull();
  });

  it('computes the next priority', () => {
    expect(storage.rules.nextPriority()).toBe(10);
    storage.rules.create(makeRule('rule-1', 10));
    expect(storage.rules.nextPriority()).toBe(20);
    storage.rules.create(makeRule('rule-2', 35));
    expect(storage.rules.nextPriority()).toBe(45);
  });

  it('reorders rules and returns the new list', () => {
    storage.rules.create(makeRule('a', 10));
    storage.rules.create(makeRule('b', 20));
    storage.rules.create(makeRule('c', 30));
    expect(storage.rules.list().map((rule) => rule.id)).toEqual(['c', 'b', 'a']);

    const reordered = storage.rules.reorder(['a', 'c', 'b']);
    expect(reordered.map((rule) => rule.id)).toEqual(['a', 'c', 'b']);
    expect(reordered.map((rule) => rule.priority)).toEqual([30, 20, 10]);
    expect(storage.rules.list().map((rule) => rule.id)).toEqual(['a', 'c', 'b']);
  });

  it('lists only enabled rules', () => {
    storage.rules.create(makeRule('enabled', 20));
    storage.rules.create(makeRule('disabled', 10, { enabled: false }));

    expect(storage.rules.listEnabled().map((rule) => rule.id)).toEqual(['enabled']);
    expect(storage.rules.counts()).toEqual({ total: 2, enabled: 1 });
  });
});
