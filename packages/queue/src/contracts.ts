import type {
  ConversationKind,
  FailureInfo,
  OutgoingMessage,
  Platform,
  PlatformCapabilities,
  RetryPolicyConfig,
  RuleEvaluationResult,
  MessageRule,
  UnifiedMessageEvent,
  UnifiedSegment,
} from '@omni-relay/shared-types';
import type { Storage } from '@omni-relay/storage';

/**
 * Internal contract between the outbox queue and the platform adapters.
 *
 * Adapters implement {@link OutboxSender}; the worker owns retries, backoff,
 * delivery attempts and dead-lettering.
 */

export interface SendTarget {
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  senderNativeId: string;
  /** Native id of the inbound message, when the platform needs a passive reply. */
  replyToNativeMessageId?: string | undefined;
  /** End of the platform's passive reply window (ISO-8601). */
  replyWindowExpiresAt?: string | undefined;
}

export interface SendResult {
  nativeMessageId: string;
}

export interface OutboxSender {
  readonly platform: Platform;
  send(message: OutgoingMessage, target: SendTarget): Promise<SendResult>;
}

export interface QueueLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface TickSummary {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
}

export interface OutboxWorkerOptions {
  storage: Storage;
  /** Returns the sender for a platform, or null when the platform is disabled. */
  resolveSender: (platform: Platform) => OutboxSender | null;
  retryPolicy: RetryPolicyConfig;
  logger?: QueueLogger | undefined;
  now?: (() => Date) | undefined;
  /** Random source in `[0, 1)`, injected for deterministic backoff tests. */
  rng?: (() => number) | undefined;
  batchSize?: number | undefined;
  pollIntervalMs?: number | undefined;
}

export interface OutboxWorker {
  /** Starts the polling loop. */
  start(): void;
  /** Stops the loop and waits for the in-flight batch. */
  stop(): Promise<void>;
  /** Processes a single batch; deterministic entry point used by tests. */
  tick(): Promise<TickSummary>;
  /** True while a batch is being processed. */
  readonly running: boolean;
}

export interface ClassifiedFailure {
  failure: FailureInfo;
  permanent: boolean;
}

// ---------------------------------------------------------------------------
// delivery planning
// ---------------------------------------------------------------------------

export interface DeliveryPlannerOptions {
  storage: Storage;
  capabilities: PlatformCapabilities;
  maxResponseSegments?: number | undefined;
  logger?: QueueLogger | undefined;
  now?: (() => Date) | undefined;
}

export interface DeliveryPlanRequest {
  event: UnifiedMessageEvent;
  /** Rule that produced the reply decision, when any. */
  rule: MessageRule | null;
  evaluation: RuleEvaluationResult;
  /** Segments already translated into the unified model. */
  segments: UnifiedSegment[];
  replyToNativeMessageId?: string | null | undefined;
  /** True when the reply is not a response to an inbound message. */
  proactive?: boolean | undefined;
}

export interface DeliveryPlanResult {
  status: 'queued' | 'blocked' | 'ignored' | 'failed';
  reason: string;
  outboxId?: string | undefined;
}

export interface DeliveryPlanner {
  /**
   * Applies capability and rate-limit gates and enqueues the outbox record.
   * Never calls a platform API.
   */
  plan(request: DeliveryPlanRequest): DeliveryPlanResult;
}
