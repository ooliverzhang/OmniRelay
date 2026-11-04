import type { FailureInfo, OutboxRecord, RetryPolicyConfig } from '@omni-relay/shared-types';

import { computeBackoff } from './backoff.js';
import { classifyDeliveryError, redactText } from './classify.js';
import type {
  OutboxSender,
  OutboxWorker,
  OutboxWorkerOptions,
  QueueLogger,
  SendTarget,
  TickSummary,
} from './contracts.js';

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_POLL_INTERVAL_MS = 1000;

type DeliveryOutcome = 'sent' | 'retried' | 'dead';
type LogLevel = keyof QueueLogger;

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * A record may carry its own attempt budget, but the worker never exceeds the
 * configured retry policy either.
 */
function resolveMaxAttempts(record: OutboxRecord, policy: RetryPolicyConfig): number {
  const recordMax = normalizePositiveInt(record.maxAttempts, 1);
  const policyMax = normalizePositiveInt(policy.maxAttempts, recordMax);
  return Math.min(recordMax, policyMax);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'unknown error';
}

function buildTarget(record: OutboxRecord): SendTarget {
  const target: SendTarget = {
    platform: record.platform,
    conversationKind: record.conversationKind,
    conversationNativeId: record.conversationNativeId,
    senderNativeId: record.senderNativeId,
  };
  if (record.payload.replyToNativeMessageId !== undefined) {
    target.replyToNativeMessageId = record.payload.replyToNativeMessageId;
  }
  if (record.payload.replyWindowExpiresAt !== undefined) {
    target.replyWindowExpiresAt = record.payload.replyWindowExpiresAt;
  }
  return target;
}

/**
 * Claims due outbox records and hands them to the platform senders.
 *
 * Retries, backoff, attempt bookkeeping and dead-lettering all live here so the
 * adapters only have to implement a single `send()` call.
 */
export function createOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const { storage, resolveSender, retryPolicy } = options;
  const logger = options.logger;
  const clock = options.now ?? ((): Date => new Date());
  const rng = options.rng ?? Math.random;
  const batchSize = normalizePositiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
  const pollIntervalMs = normalizePositiveInt(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);

  let activeTick: Promise<TickSummary> | null = null;
  let timer: NodeJS.Timeout | null = null;

  /** Logging must never be the reason a delivery fails. */
  const log = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (logger === undefined) {
      return;
    }
    try {
      logger[level](message, meta);
    } catch {
      // Ignore logger failures.
    }
  };

  const markDead = (
    record: OutboxRecord,
    attemptNumber: number,
    failure: FailureInfo,
    startedAt: Date,
  ): DeliveryOutcome => {
    const finishedAt = clock();
    storage.outbox.markDead(record.id, { failure, now: finishedAt });
    storage.attempts.record({
      outboxId: record.id,
      attempt: attemptNumber,
      status: 'permanent_error',
      errorCode: failure.code,
      errorMessage: failure.message,
      startedAt,
      finishedAt,
    });
    log('warn', 'outbox_message_dead', {
      outboxId: record.id,
      platform: record.platform,
      code: failure.code,
      attempts: attemptNumber,
    });
    return 'dead';
  };

  const deliver = async (record: OutboxRecord): Promise<DeliveryOutcome> => {
    const attemptNumber = record.attempts + 1;
    const startedAt = clock();

    let sender: OutboxSender | null;
    try {
      sender = resolveSender(record.platform);
    } catch (error) {
      return markDead(
        record,
        attemptNumber,
        {
          kind: 'permanent',
          code: 'sender_resolution_failed',
          message: redactText(describeError(error)),
        },
        startedAt,
      );
    }

    if (sender === null) {
      return markDead(
        record,
        attemptNumber,
        {
          kind: 'permanent',
          code: 'platform_disabled',
          message: `Platform "${record.platform}" is disabled or has no sender`,
        },
        startedAt,
      );
    }

    try {
      const result = await sender.send(record.payload, buildTarget(record));
      const finishedAt = clock();
      storage.outbox.markSent(record.id, {
        nativeMessageId: result.nativeMessageId,
        now: finishedAt,
      });
      storage.attempts.record({
        outboxId: record.id,
        attempt: attemptNumber,
        status: 'success',
        startedAt,
        finishedAt,
      });
      log('info', 'outbox_message_sent', {
        outboxId: record.id,
        platform: record.platform,
        attempts: attemptNumber,
      });
      return 'sent';
    } catch (error) {
      const finishedAt = clock();
      const classified = classifyDeliveryError(error);
      const failure = classified.failure;
      if (classified.permanent || attemptNumber >= resolveMaxAttempts(record, retryPolicy)) {
        return markDead(record, attemptNumber, failure, startedAt);
      }

      const delayMs = computeBackoff(attemptNumber, retryPolicy, rng);
      const nextAttemptAt = new Date(finishedAt.getTime() + delayMs);
      storage.outbox.markRetry(record.id, { failure, nextAttemptAt, now: finishedAt });
      storage.attempts.record({
        outboxId: record.id,
        attempt: attemptNumber,
        status: 'retryable_error',
        errorCode: failure.code,
        errorMessage: failure.message,
        startedAt,
        finishedAt,
      });
      log('warn', 'outbox_message_retry', {
        outboxId: record.id,
        platform: record.platform,
        code: failure.code,
        attempts: attemptNumber,
        delayMs,
      });
      return 'retried';
    }
  };

  const executeTick = async (): Promise<TickSummary> => {
    const summary: TickSummary = { claimed: 0, sent: 0, retried: 0, dead: 0 };

    let claimed: OutboxRecord[];
    try {
      claimed = storage.outbox.claimDue({ limit: batchSize, now: clock() });
    } catch (error) {
      log('error', 'outbox_claim_failed', { error: redactText(describeError(error)) });
      return summary;
    }
    summary.claimed = claimed.length;

    for (const record of claimed) {
      // One poisoned message must never abort the rest of the batch.
      try {
        const outcome = await deliver(record);
        if (outcome === 'sent') {
          summary.sent += 1;
        } else if (outcome === 'retried') {
          summary.retried += 1;
        } else {
          summary.dead += 1;
        }
      } catch (error) {
        log('error', 'outbox_delivery_crashed', {
          outboxId: record.id,
          platform: record.platform,
          error: redactText(describeError(error)),
        });
      }
    }

    if (summary.claimed > 0) {
      log('debug', 'outbox_tick', {
        claimed: summary.claimed,
        sent: summary.sent,
        retried: summary.retried,
        dead: summary.dead,
      });
    }
    return summary;
  };

  const beginTick = (): Promise<TickSummary> => {
    if (activeTick !== null) {
      return activeTick;
    }
    const promise = executeTick();
    activeTick = promise;
    void promise.finally(() => {
      if (activeTick === promise) {
        activeTick = null;
      }
    });
    return promise;
  };

  const worker: OutboxWorker = {
    start(): void {
      if (timer !== null) {
        return;
      }
      timer = setInterval(() => {
        // A tick that is still running makes this poll a no-op.
        void beginTick();
      }, pollIntervalMs);
      // Never keep the process alive just because the worker is polling.
      timer.unref();
      log('info', 'outbox_worker_started', { pollIntervalMs, batchSize });
    },

    async stop(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        log('info', 'outbox_worker_stopped', {});
      }
      const pending = activeTick;
      if (pending !== null) {
        try {
          await pending;
        } catch {
          // A tick never rejects, but stop() must stay safe regardless.
        }
      }
    },

    tick(): Promise<TickSummary> {
      return beginTick();
    },

    get running(): boolean {
      return activeTick !== null;
    },
  };

  return worker;
}
