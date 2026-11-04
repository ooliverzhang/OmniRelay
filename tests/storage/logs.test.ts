import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOG_RETENTION_MAX_ROWS, type Storage } from '@omni-relay/storage';

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

describe('logs', () => {
  it('appends entries and lists them newest first', () => {
    storage.logs.append({ level: 'info', msg: 'first', platform: 'discord', event: 'startup' });
    clock.advance(1_000);
    storage.logs.append({
      level: 'warn',
      msg: 'second',
      platform: 'qq-official',
      event: 'delivery',
      context: { attempt: 1 },
    });

    const page = storage.logs.list({});
    expect(page.total).toBe(2);
    expect(page.items.map((row) => row.msg)).toEqual(['second', 'first']);
    expect(page.items[0]?.platform).toBe('qq-official');
    expect(page.items[0]?.event).toBe('delivery');
    expect(page.items[0]?.context).toEqual({ attempt: 1 });
    expect(page.items[0]?.id).toMatch(/^log_/);
    expect(page.items[0]?.time).toBe(clock.now().toISOString());
  });

  it('filters by level, platform and message text', () => {
    storage.logs.append({ level: 'info', msg: 'platform connected', platform: 'discord' });
    storage.logs.append({ level: 'error', msg: 'send failed', platform: 'discord' });
    storage.logs.append({ level: 'warn', msg: 'rate limited', platform: 'qq-official' });

    expect(storage.logs.list({ level: 'error' }).total).toBe(1);
    expect(storage.logs.list({ platform: 'discord' }).total).toBe(2);
    expect(storage.logs.list({ search: 'failed' }).total).toBe(1);
    expect(storage.logs.list({ level: 'error', platform: 'discord' }).total).toBe(1);
    expect(storage.logs.list({ level: 'debug' }).total).toBe(0);
  });

  it('returns recent warnings and errors', () => {
    storage.logs.append({ level: 'debug', msg: 'debug entry' });
    storage.logs.append({ level: 'info', msg: 'info entry' });
    for (let index = 0; index < 12; index += 1) {
      clock.advance(1_000);
      storage.logs.append({ level: index % 2 === 0 ? 'warn' : 'error', msg: `problem ${index}` });
    }

    const recent = storage.logs.recentErrors();
    expect(recent).toHaveLength(10);
    expect(recent.every((row) => row.level === 'warn' || row.level === 'error')).toBe(true);
    expect(recent[0]?.msg).toBe('problem 11');

    expect(storage.logs.recentErrors(3)).toHaveLength(3);
    expect(storage.logs.recentErrors(0)).toHaveLength(10);
  });

  it('paginates log entries', () => {
    for (let index = 0; index < 5; index += 1) {
      clock.advance(1_000);
      storage.logs.append({ level: 'info', msg: `entry ${index}` });
    }

    const page = storage.logs.list({ pageSize: 2 });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.msg).toBe('entry 4');
    expect(storage.logs.list({ pageSize: 2, page: 3 }).items).toHaveLength(1);
  });

  it('prunes to the newest rows', () => {
    for (let index = 0; index < 5; index += 1) {
      clock.advance(1_000);
      storage.logs.append({ level: 'info', msg: `entry ${index}` });
    }

    expect(storage.logs.prune(2)).toBe(3);
    expect(storage.logs.list({}).total).toBe(2);
    expect(storage.logs.list({}).items.map((row) => row.msg)).toEqual(['entry 4', 'entry 3']);
    expect(storage.logs.prune()).toBe(0);
  });

  it('keeps the ring buffer bounded', () => {
    expect(LOG_RETENTION_MAX_ROWS).toBe(5000);
    // append() prunes on every write, so a small buffer must stay untouched.
    storage.logs.append({ level: 'info', msg: 'entry' });
    expect(storage.logs.list({}).total).toBe(1);
    expect(storage.logs.prune(0)).toBe(1);
    expect(storage.logs.list({}).total).toBe(0);
  });
});
