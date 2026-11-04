import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '@omni-relay/storage';
import type { OutgoingMessage } from '@omni-relay/shared-types';

import { createClock, createStorage, type TestClock } from './helpers';

const HOUR_MS = 60 * 60 * 1000;

let storage: Storage;
let clock: TestClock;

beforeEach(() => {
  clock = createClock('2026-01-01T00:00:00.000Z');
  storage = createStorage(clock.now);
});

afterEach(() => {
  storage.close();
});

function outgoing(text = 'hello'): OutgoingMessage {
  return { kind: 'group', segments: [{ type: 'text', text }], proactive: false };
}

function enqueue(
  bridgeMessageId: string,
  options: { nextAttemptAt?: Date; maxAttempts?: number; text?: string } = {},
) {
  return storage.outbox.enqueue({
    platform: 'discord',
    conversationKind: 'group',
    conversationNativeId: 'channel-1',
    senderNativeId: 'user-1',
    payload: outgoing(options.text),
    bridgeMessageId,
    nextAttemptAt: options.nextAttemptAt,
    maxAttempts: options.maxAttempts,
  });
}

describe('outbox', () => {
  it('enqueues a queued record with defaults', () => {
    const record = enqueue('bridge-1');

    expect(record.id).toMatch(/^out_/);
    expect(record.status).toBe('queued');
    expect(record.attempts).toBe(0);
    expect(record.maxAttempts).toBe(5);
    expect(record.nextAttemptAt).toBe(clock.now().toISOString());
    expect(record.createdAt).toBe(clock.now().toISOString());
    expect(storage.outbox.dueCount()).toBe(1);
    expect(storage.outbox.stats().queued).toBe(1);
  });

  it('claims due records exactly once and snapshots them before claiming', () => {
    const record = enqueue('bridge-1');

    const claimed = storage.outbox.claimDue();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(record.id);
    expect(claimed[0]?.payload.segments).toEqual([{ type: 'text', text: 'hello' }]);
    // The returned snapshot predates the status flip.
    expect(claimed[0]?.status).toBe('queued');
    expect(storage.outbox.get(record.id)?.status).toBe('sending');
    expect(storage.outbox.claimDue()).toEqual([]);
  });

  it('claims in next-attempt order and honours the limit', () => {
    const later = enqueue('bridge-later', {
      nextAttemptAt: new Date(clock.now().getTime() + 60_000),
    });
    const now = enqueue('bridge-now');
    const earlier = enqueue('bridge-earlier', {
      nextAttemptAt: new Date(clock.now().getTime() - 1_000),
    });

    const claimed = storage.outbox.claimDue({ limit: 2 });
    expect(claimed.map((record) => record.id)).toEqual([earlier.id, now.id]);
    expect(claimed).toHaveLength(2);
    expect(storage.outbox.claimDue()).toEqual([]);
    expect(storage.outbox.dueCount()).toBe(0);

    clock.advance(60_000);
    expect(storage.outbox.claimDue().map((record) => record.id)).toEqual([later.id]);
  });

  it('marks records as sent and counts them for 24 hours', () => {
    const record = enqueue('bridge-1');
    storage.outbox.claimDue();

    storage.outbox.markSent(record.id, { nativeMessageId: 'native-1' });
    expect(storage.outbox.get(record.id)?.status).toBe('sent');
    expect(storage.outbox.stats().sent24h).toBe(1);

    const later = new Date(clock.now().getTime() + 25 * HOUR_MS);
    expect(storage.outbox.stats(later).sent24h).toBe(0);
  });

  it('rejects marking unknown records', () => {
    expect(() => storage.outbox.markSent('missing')).toThrow(/does not exist/);
    expect(() =>
      storage.outbox.markRetry('missing', {
        failure: { kind: 'retryable', code: 'timeout', message: 'slow' },
        nextAttemptAt: clock.now(),
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      storage.outbox.markDead('missing', {
        failure: { kind: 'permanent', code: 'forbidden', message: 'nope' },
      }),
    ).toThrow(/does not exist/);
  });

  it('marks retries, increments attempts and reschedules', () => {
    const record = enqueue('bridge-1');
    storage.outbox.claimDue();

    const nextAttemptAt = new Date(clock.now().getTime() + 5_000);
    storage.outbox.markRetry(record.id, {
      failure: { kind: 'retryable', code: 'platform_unavailable', message: 'upstream 503' },
      nextAttemptAt,
    });

    const updated = storage.outbox.get(record.id);
    expect(updated?.status).toBe('retrying');
    expect(updated?.attempts).toBe(1);
    expect(updated?.lastError).toEqual({
      kind: 'retryable',
      code: 'platform_unavailable',
      message: 'upstream 503',
    });
    expect(updated?.nextAttemptAt).toBe(nextAttemptAt.toISOString());
    expect(storage.outbox.dueCount()).toBe(0);
    expect(storage.outbox.dueCount(nextAttemptAt)).toBe(1);

    clock.advance(5_000);
    expect(storage.outbox.claimDue()).toHaveLength(1);
  });

  it('moves dead records into the dead-letter table', () => {
    const record = enqueue('bridge-1');
    storage.outbox.claimDue();

    const dead = storage.outbox.markDead(record.id, {
      failure: { kind: 'permanent', code: 'unauthorized', message: 'bad bot token' },
    });

    expect(dead.id).toMatch(/^dl_/);
    expect(dead.outboxId).toBe(record.id);
    expect(dead.platform).toBe('discord');
    expect(dead.reasonCode).toBe('unauthorized');
    expect(dead.reasonMessage).toBe('bad bot token');
    expect(dead.conversationKind).toBe('group');
    expect(dead.conversationNativeId).toBe('channel-1');
    expect(dead.attempts).toBe(1);
    expect(dead.failedAt).toBe(clock.now().toISOString());
    expect(dead.payload.segments).toEqual([{ type: 'text', text: 'hello' }]);

    expect(storage.outbox.get(record.id)).toBeNull();
    expect(storage.deadLetters.count()).toBe(1);
    expect(storage.outbox.stats().dead).toBe(1);
    expect(storage.outbox.stats().failed24h).toBe(1);
    expect(storage.outbox.stats().queued).toBe(0);
    expect(storage.outbox.stats().sending).toBe(0);
  });

  it('counts the failed attempt in the dead letter', () => {
    const record = enqueue('bridge-1');
    storage.outbox.claimDue();
    storage.outbox.markRetry(record.id, {
      failure: { kind: 'retryable', code: 'timeout', message: 'slow' },
      nextAttemptAt: clock.now(),
    });
    storage.outbox.claimDue();

    const dead = storage.outbox.markDead(record.id, {
      failure: { kind: 'retryable', code: 'timeout', message: 'still slow' },
    });
    expect(dead.attempts).toBe(2);
  });

  it('lists and paginates dead letters', () => {
    for (let index = 0; index < 3; index += 1) {
      const record = enqueue(`bridge-${index}`);
      storage.outbox.claimDue();
      storage.outbox.markDead(record.id, {
        failure: { kind: 'permanent', code: 'forbidden', message: `failure ${index}` },
      });
      clock.advance(1_000);
    }

    const firstPage = storage.deadLetters.list({ pageSize: 2 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.items).toHaveLength(2);
    // Newest failure first.
    expect(firstPage.items[0]?.reasonMessage).toBe('failure 2');

    const secondPage = storage.deadLetters.list({ pageSize: 2, page: 2 });
    expect(secondPage.items).toHaveLength(1);

    expect(storage.deadLetters.list({ platform: 'qq-official' }).total).toBe(0);
    expect(storage.deadLetters.list({ platform: 'discord' }).total).toBe(3);

    const dead = firstPage.items[0];
    expect(dead).toBeDefined();
    if (dead !== undefined) {
      expect(storage.deadLetters.get(dead.id)?.id).toBe(dead.id);
      expect(storage.deadLetters.delete(dead.id)).toBe(true);
      expect(storage.deadLetters.delete(dead.id)).toBe(false);
      expect(storage.deadLetters.count()).toBe(2);
    }
  });

  it('requeues sent records and deletes them', () => {
    const record = enqueue('bridge-1');
    storage.outbox.claimDue();
    storage.outbox.markSent(record.id);

    expect(storage.outbox.requeue(record.id)).toBe(true);
    const requeued = storage.outbox.get(record.id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.attempts).toBe(0);
    expect(storage.outbox.dueCount()).toBe(1);

    expect(storage.outbox.delete(record.id)).toBe(true);
    expect(storage.outbox.get(record.id)).toBeNull();
    expect(storage.outbox.delete(record.id)).toBe(false);
    expect(storage.outbox.requeue(record.id)).toBe(false);
  });

  it('records delivery attempts', () => {
    const record = enqueue('bridge-1');
    const startedAt = clock.now();
    const first = storage.attempts.record({
      outboxId: record.id,
      attempt: 1,
      status: 'retryable_error',
      errorCode: 'timeout',
      errorMessage: 'slow',
      startedAt,
      finishedAt: startedAt,
    });
    storage.attempts.record({
      outboxId: record.id,
      attempt: 2,
      status: 'success',
      startedAt,
      finishedAt: startedAt,
    });

    expect(first.id).toMatch(/^att_/);
    expect(first.errorCode).toBe('timeout');
    expect(storage.attempts.count()).toBe(2);
    const attempts = storage.attempts.listByOutbox(record.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['retryable_error', 'success']);
    expect(attempts[1]?.errorCode).toBeUndefined();
  });

  it('lists records and counts them by status', () => {
    enqueue('bridge-1');
    enqueue('bridge-2');
    enqueue('bridge-3');
    storage.outbox.claimDue({ limit: 1 });

    expect(storage.outbox.countByStatus()).toEqual({ queued: 2, sending: 1 });
    expect(storage.outbox.list({}).total).toBe(3);
    expect(storage.outbox.list({ status: 'queued' }).total).toBe(2);
    expect(storage.outbox.list({ platform: 'discord' }).total).toBe(3);
    expect(storage.outbox.list({ platform: 'qq-official' }).total).toBe(0);

    const page = storage.outbox.list({ pageSize: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(storage.outbox.list({ pageSize: 2, page: 2 }).items).toHaveLength(1);
  });

  it('uses a custom maxAttempts and nextAttemptAt', () => {
    const record = enqueue('bridge-1', {
      maxAttempts: 2,
      nextAttemptAt: new Date(clock.now().getTime() + 30_000),
    });
    expect(record.maxAttempts).toBe(2);
    expect(storage.outbox.dueCount()).toBe(0);
    clock.advance(30_000);
    expect(storage.outbox.dueCount()).toBe(1);
    expect(storage.outbox.claimDue()[0]?.maxAttempts).toBe(2);
  });
});
