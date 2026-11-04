import type { ConversationKind, Platform } from './platform.js';
import type { OutgoingMessage } from './message.js';

/**
 * Delivery status vocabulary mandated by the specification.
 *
 * `ignored` / `blocked` are rule decisions, not errors.
 */
export const DELIVERY_STATUS = [
  'ignored',
  'blocked',
  'queued',
  'sending',
  'sent',
  'failed',
  'dead',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUS)[number];

export type FailureKind = 'retryable' | 'permanent';

export interface FailureInfo {
  kind: FailureKind;
  code: string;
  message: string;
  /** Honour platform supplied Retry-After headers, in milliseconds. */
  retryAfterMs?: number;
}

export interface OutboxRecord {
  id: string;
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  senderNativeId: string;
  payload: OutgoingMessage;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError?: FailureInfo;
  ruleId?: string;
  bridgeMessageId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryAttemptRecord {
  id: string;
  outboxId: string;
  attempt: number;
  status: 'success' | 'retryable_error' | 'permanent_error';
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt: string;
}

export interface DeadLetterRecord {
  id: string;
  outboxId: string;
  platform: Platform;
  reasonCode: string;
  reasonMessage: string;
  payload: OutgoingMessage;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  failedAt: string;
  attempts: number;
}

export interface RetryPolicyConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** 0..1 random jitter applied to every delay. */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
};

export interface RateLimitBucketKey {
  scope: 'user' | 'conversation' | 'platform' | 'global';
  scopeId: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the next slot is available. */
  retryAfterMs: number;
  limit: number;
  windowSeconds: number;
}
