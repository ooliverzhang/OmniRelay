import { checkDeliveryCapability } from '@omni-relay/capabilities';
import type { MessageRule, OutgoingMessage, RateLimitScope } from '@omni-relay/shared-types';

import { redactText } from './classify.js';
import type {
  DeliveryPlanRequest,
  DeliveryPlanResult,
  DeliveryPlanner,
  DeliveryPlannerOptions,
  QueueLogger,
} from './contracts.js';

function resolveScopeId(scope: RateLimitScope, request: DeliveryPlanRequest): string {
  const { event } = request;
  switch (scope) {
    case 'user':
      return event.sender.nativeId;
    case 'conversation':
      return `${event.platform}:${event.conversation.nativeId}`;
    case 'platform':
      return event.platform;
    case 'global':
    default:
      return 'global';
  }
}

/** Smallest configured segment budget, or `null` when none is configured. */
function resolveSegmentBudget(
  explicit: number | undefined,
  rule: MessageRule | null,
): number | null {
  const limits: number[] = [];
  if (explicit !== undefined && Number.isFinite(explicit)) {
    limits.push(Math.max(0, Math.floor(explicit)));
  }
  const ruleLimit = rule?.response.maxResponseSegments;
  if (ruleLimit !== undefined && Number.isFinite(ruleLimit)) {
    limits.push(Math.max(0, Math.floor(ruleLimit)));
  }
  if (limits.length === 0) {
    return null;
  }
  return Math.min(...limits);
}

function safeBridgeMessageId(request: DeliveryPlanRequest): string | null {
  try {
    return request.event?.meta?.bridgeMessageId ?? null;
  } catch {
    return null;
  }
}

/**
 * Gatekeeper between the rule engine and the outbox.
 *
 * It only decides and enqueues: no platform API is ever called from here, and
 * any unexpected failure degrades to `{ status: 'failed' }` instead of throwing
 * into the inbound pipeline.
 */
export function createDeliveryPlanner(options: DeliveryPlannerOptions): DeliveryPlanner {
  const { storage, capabilities } = options;
  const logger = options.logger;
  const clock = options.now ?? ((): Date => new Date());

  const log = (level: keyof QueueLogger, message: string, meta?: Record<string, unknown>): void => {
    if (logger === undefined) {
      return;
    }
    try {
      logger[level](message, meta);
    } catch {
      // Ignore logger failures.
    }
  };

  return {
    plan(request: DeliveryPlanRequest): DeliveryPlanResult {
      try {
        const { event, rule, evaluation, segments } = request;

        if (evaluation.decision !== 'reply') {
          return {
            status: evaluation.status === 'blocked' ? 'blocked' : 'ignored',
            reason: evaluation.reason,
          };
        }

        const proactive = request.proactive === true;
        const capability = checkDeliveryCapability(capabilities, {
          conversationKind: event.conversation.kind,
          proactive,
        });
        if (!capability.allowed) {
          return {
            status: 'blocked',
            reason: capability.reason ?? `capability_unsupported:${event.conversation.kind}`,
          };
        }

        const segmentBudget = resolveSegmentBudget(options.maxResponseSegments, rule);
        if (segmentBudget !== null && segments.length > segmentBudget) {
          return { status: 'failed', reason: 'response_segment_budget_exceeded' };
        }

        const rateLimit = rule?.rateLimit;
        if (rateLimit !== undefined) {
          const decision = storage.rateLimits.consume(
            { scope: rateLimit.scope, scopeId: resolveScopeId(rateLimit.scope, request) },
            { maxMessages: rateLimit.maxMessages, windowSeconds: rateLimit.windowSeconds },
            clock(),
          );
          if (!decision.allowed) {
            return { status: 'blocked', reason: 'rate_limited' };
          }
        }

        const payload: OutgoingMessage = {
          kind: event.conversation.kind,
          segments,
          proactive,
        };
        const replyToNativeMessageId = request.replyToNativeMessageId;
        if (replyToNativeMessageId !== null && replyToNativeMessageId !== undefined) {
          payload.replyToNativeMessageId = replyToNativeMessageId;
        }
        const replyWindowExpiresAt = event.replyContext?.expiresAt;
        if (replyWindowExpiresAt !== undefined) {
          payload.replyWindowExpiresAt = replyWindowExpiresAt;
        }

        const record = storage.outbox.enqueue({
          platform: event.platform,
          conversationKind: event.conversation.kind,
          conversationNativeId: event.conversation.nativeId,
          senderNativeId: event.sender.nativeId,
          payload,
          bridgeMessageId: event.meta.bridgeMessageId,
          ...(rule === null ? {} : { ruleId: rule.id }),
        });
        log('debug', 'delivery_queued', { outboxId: record.id, platform: event.platform });
        return { status: 'queued', reason: 'queued', outboxId: record.id };
      } catch (error) {
        log('error', 'delivery_plan_failed', {
          bridgeMessageId: safeBridgeMessageId(request),
          error: redactText(error instanceof Error ? error.message : 'unknown error'),
        });
        return { status: 'failed', reason: 'enqueue_failed' };
      }
    },
  };
}
