import { afterEach, describe, expect, it } from 'vitest';

import {
  computeBackoff,
  createOutboxWorker,
  type OutboxSender,
  type OutboxWorker,
  type SendTarget,
} from '@omni-relay/queue';
import { openStorage, type Storage } from '@omni-relay/storage';
import {
  BridgeError,
  type OutgoingMessage,
  type RetryPolicyConfig,
} from '@omni-relay/shared-types';

const START = '2026-01-01T00:00:00.000Z';
const RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};
const FIXED_RNG = (): number => 0.5;

const openStores: Storage[] = [];

afterEach(() => {
  while (openStores.length > 0) {
    openStores.pop()?.close();
  }
});

interface TestClock {
  now: () => Date;
  advance: (ms: number) => Date;
}

function createClock(): TestClock {
  let current = new Date(START);
  return {
    now: () => current,
    advance(ms: number): Date {
      current = new Date(current.getTime() + ms);
      return current;
    },
  };
}

function outgoing(text: string): OutgoingMessage {
  return { kind: 'group', segments: [{ type: 'text', text }], proactive: false };
}

interface SentCall {
  message: OutgoingMessage;
  target: SendTarget;
}

interface Harness {
  storage: Storage;
  clock: TestClock;
  worker: OutboxWorker;
  sender: OutboxSender;
  sent: SentCall[];
}

function setup(
  options: {
    send?: OutboxSender['send'];
    resolveSender?: () => OutboxSender | null;
    retryPolicy?: RetryPolicyConfig;
    pollIntervalMs?: number;
    logger?: {
      debug: (message: string, meta?: Record<string, unknown>) => void;
      info: (message: string, meta?: Record<string, unknown>) => void;
      warn: (message: string, meta?: Record<string, unknown>) => void;
      error: (message: string, meta?: Record<string, unknown>) => void;
    };
  } = {},
): Harness {
  const clock = createClock();
  const storage = openStorage({ sqlitePath: ':memory:', now: clock.now });
  openStores.push(storage);

  const sent: SentCall[] = [];
  const defaultSend: OutboxSender['send'] = async (message, target) => {
    sent.push({ message, target });
    return { nativeMessageId: 'native-1' };
  };
  const sender: OutboxSender = { platform: 'discord', send: options.send ?? defaultSend };
  const worker = createOutboxWorker({
    storage,
    resolveSender: options.resolveSender ?? (() => sender),
    retryPolicy: options.retryPolicy ?? RETRY_POLICY,
    now: clock.now,
    rng: FIXED_RNG,
    logger: options.logger,
    pollIntervalMs: options.pollIntervalMs,
  });

  return { storage, clock, worker, sender, sent };
}

function enqueue(
  storage: Storage,
  bridgeMessageId: string,
  text = 'hello',
  options: { maxAttempts?: number; nextAttemptAt?: Date } = {},
): string {
  const record = storage.outbox.enqueue({
    platform: 'discord',
    conversationKind: 'group',
    conversationNativeId: 'channel-1',
    senderNativeId: 'user-1',
    payload: outgoing(text),
    bridgeMessageId,
    maxAttempts: options.maxAttempts,
    nextAttemptAt: options.nextAttemptAt,
  });
  return record.id;
}

describe('outbox worker', () => {
  it('delivers a due record and records a successful attempt', async () => {
    const harness = setup();
    const id = enqueue(harness.storage, 'bridge-1');

    const summary = await harness.worker.tick();

    expect(summary).toEqual({ claimed: 1, sent: 1, retried: 0, dead: 0 });
    expect(harness.storage.outbox.stats().sent24h).toBe(1);
    expect(harness.storage.outbox.get(id)?.status).toBe('sent');

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.target).toEqual({
      platform: 'discord',
      conversationKind: 'group',
      conversationNativeId: 'channel-1',
      senderNativeId: 'user-1',
    });
    expect(harness.sent[0]?.message.segments).toEqual([{ type: 'text', text: 'hello' }]);

    const attempts = harness.storage.attempts.listByOutbox(id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['success']);
    expect(attempts[0]?.attempt).toBe(1);
  });

  it('forwards reply metadata to the sender', async () => {
    const harness = setup();
    harness.storage.outbox.enqueue({
      platform: 'discord',
      conversationKind: 'group',
      conversationNativeId: 'channel-1',
      senderNativeId: 'user-1',
      payload: {
        kind: 'group',
        segments: [{ type: 'text', text: 'pong' }],
        replyToNativeMessageId: 'native-0',
        proactive: false,
        replyWindowExpiresAt: '2026-01-01T00:05:00.000Z',
      },
      bridgeMessageId: 'bridge-1',
    });

    await harness.worker.tick();

    expect(harness.sent[0]?.target.replyToNativeMessageId).toBe('native-0');
    expect(harness.sent[0]?.target.replyWindowExpiresAt).toBe('2026-01-01T00:05:00.000Z');
  });

  it('schedules a retry for transient failures', async () => {
    const harness = setup({
      send: async () => {
        throw new BridgeError({ code: 'platform_unavailable', message: 'upstream 503' });
      },
    });
    const id = enqueue(harness.storage, 'bridge-1');

    const summary = await harness.worker.tick();

    expect(summary).toEqual({ claimed: 1, sent: 0, retried: 1, dead: 0 });
    const record = harness.storage.outbox.get(id);
    expect(record?.status).toBe('retrying');
    expect(record?.attempts).toBe(1);
    expect(record?.lastError?.code).toBe('platform_unavailable');
    const delay = computeBackoff(1, RETRY_POLICY, FIXED_RNG);
    expect(record?.nextAttemptAt).toBe(new Date(new Date(START).getTime() + delay).toISOString());
    expect(harness.storage.attempts.listByOutbox(id)[0]?.status).toBe('retryable_error');
  });

  it('dead-letters permanent failures immediately', async () => {
    const harness = setup({
      send: async () => {
        throw new BridgeError({ code: 'unauthorized', message: 'bad bot token' });
      },
    });
    const id = enqueue(harness.storage, 'bridge-1');

    const summary = await harness.worker.tick();

    expect(summary).toEqual({ claimed: 1, sent: 0, retried: 0, dead: 1 });
    expect(harness.storage.outbox.get(id)).toBeNull();

    const deadLetters = harness.storage.deadLetters.list({});
    expect(deadLetters.total).toBe(1);
    expect(deadLetters.items[0]?.reasonCode).toBe('unauthorized');
    expect(deadLetters.items[0]?.attempts).toBe(1);
    expect(harness.storage.attempts.listByOutbox(id)[0]?.status).toBe('permanent_error');
  });

  it('dead-letters records for platforms without a sender', async () => {
    const harness = setup({ resolveSender: () => null });
    const id = enqueue(harness.storage, 'bridge-1');

    const summary = await harness.worker.tick();

    expect(summary.dead).toBe(1);
    const dead = harness.storage.deadLetters.list({}).items[0];
    expect(dead?.reasonCode).toBe('platform_disabled');
    expect(harness.storage.attempts.listByOutbox(id)[0]?.errorCode).toBe('platform_disabled');
    expect(harness.sent).toHaveLength(0);
  });

  it('dead-letters records when the sender resolver throws', async () => {
    const harness = setup({
      resolveSender: () => {
        throw new Error('registry exploded');
      },
    });
    enqueue(harness.storage, 'bridge-1');

    const summary = await harness.worker.tick();

    expect(summary.dead).toBe(1);
    expect(harness.storage.deadLetters.list({}).items[0]?.reasonCode).toBe(
      'sender_resolution_failed',
    );
  });

  it('dead-letters retryable failures once maxAttempts is exhausted', async () => {
    const harness = setup({
      send: async () => {
        throw new BridgeError({ code: 'timeout', message: 'still slow' });
      },
      retryPolicy: { ...RETRY_POLICY, maxAttempts: 2 },
    });
    // The record keeps the storage default (5); the policy caps it at 2.
    const id = enqueue(harness.storage, 'bridge-1');

    expect((await harness.worker.tick()).retried).toBe(1);
    expect(harness.storage.outbox.get(id)?.attempts).toBe(1);

    const delay = computeBackoff(1, { ...RETRY_POLICY, maxAttempts: 2 }, FIXED_RNG);
    harness.clock.advance(delay);
    expect((await harness.worker.tick()).dead).toBe(1);

    expect(harness.storage.outbox.get(id)).toBeNull();
    const dead = harness.storage.deadLetters.list({}).items[0];
    expect(dead?.reasonCode).toBe('timeout');
    expect(dead?.attempts).toBe(2);
    expect(harness.storage.attempts.listByOutbox(id).map((attempt) => attempt.status)).toEqual([
      'retryable_error',
      'permanent_error',
    ]);
  });

  it('honours a per-record attempt budget below the policy', async () => {
    const harness = setup({
      send: async () => {
        throw new BridgeError({ code: 'timeout', message: 'still slow' });
      },
    });
    const id = enqueue(harness.storage, 'bridge-1', 'hello', { maxAttempts: 2 });

    expect((await harness.worker.tick()).retried).toBe(1);
    harness.clock.advance(computeBackoff(1, RETRY_POLICY, FIXED_RNG));
    expect((await harness.worker.tick()).dead).toBe(1);

    expect(harness.storage.deadLetters.list({}).items[0]?.attempts).toBe(2);
    expect(harness.storage.outbox.get(id)).toBeNull();
  });

  it('keeps processing the batch when one message fails', async () => {
    const harness = setup({
      send: async (message) => {
        const first = message.segments[0];
        if (first?.type === 'text' && first.text === 'fail') {
          throw new BridgeError({ code: 'platform_unavailable', message: 'boom' });
        }
        return { nativeMessageId: 'native-ok' };
      },
    });
    enqueue(harness.storage, 'bridge-fail', 'fail');
    enqueue(harness.storage, 'bridge-ok', 'ok');

    const summary = await harness.worker.tick();

    expect(summary).toEqual({ claimed: 2, sent: 1, retried: 1, dead: 0 });
    expect(harness.storage.outbox.stats().sent24h).toBe(1);
    expect(harness.storage.outbox.stats().retrying).toBe(1);
  });

  it('does nothing when no records are due', async () => {
    const harness = setup();
    expect(await harness.worker.tick()).toEqual({ claimed: 0, sent: 0, retried: 0, dead: 0 });

    harness.storage.outbox.enqueue({
      platform: 'discord',
      conversationKind: 'group',
      conversationNativeId: 'channel-1',
      senderNativeId: 'user-1',
      payload: outgoing('later'),
      bridgeMessageId: 'bridge-later',
      nextAttemptAt: new Date(new Date(START).getTime() + 60_000),
    });
    expect((await harness.worker.tick()).claimed).toBe(0);
  });

  it('reports running state and stop waits for the in-flight batch', async () => {
    let resolveSend: ((value: { nativeMessageId: string }) => void) | null = null;
    const harness = setup({
      send: () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    });
    enqueue(harness.storage, 'bridge-1');

    const tick = harness.worker.tick();
    expect(harness.worker.running).toBe(true);
    await Promise.resolve();
    expect(harness.worker.running).toBe(true);

    const stopped = harness.worker.stop();
    expect(resolveSend).not.toBeNull();
    resolveSend?.({ nativeMessageId: 'native-1' });

    const summary = await tick;
    await stopped;
    expect(summary.sent).toBe(1);
    expect(harness.worker.running).toBe(false);
  });

  it('polls in the background and stops safely', async () => {
    const harness = setup({ pollIntervalMs: 5 });
    enqueue(harness.storage, 'bridge-1');
    enqueue(harness.storage, 'bridge-2');

    harness.worker.start();
    harness.worker.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await harness.worker.stop();
    await harness.worker.stop();

    expect(harness.storage.outbox.stats().sent24h).toBe(2);
    expect(harness.worker.running).toBe(false);
  });

  it('never logs payload contents', async () => {
    const entries: string[] = [];
    const record = (message: string, meta?: Record<string, unknown>): void => {
      entries.push(`${message} ${JSON.stringify(meta ?? {})}`);
    };
    const harness = setup({
      logger: { debug: record, info: record, warn: record, error: record },
    });
    enqueue(harness.storage, 'bridge-1', 'super-secret-token-value');

    await harness.worker.tick();

    const combined = entries.join('\n');
    expect(combined).toContain('outbox_message_sent');
    expect(combined).not.toContain('super-secret-token-value');
  });
});
