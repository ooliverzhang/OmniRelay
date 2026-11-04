import { afterEach, describe, expect, it } from 'vitest';

import {
  createDeliveryPlanner,
  type DeliveryPlanRequest,
  type DeliveryPlanner,
} from '@omni-relay/queue';
import { DEFAULT_CAPABILITIES, CONSERVATIVE_CAPABILITIES } from '@omni-relay/capabilities';
import { openStorage, type Storage } from '@omni-relay/storage';
import {
  DEFAULT_RESPONSE_POLICY,
  type ConversationKind,
  type MessageRule,
  type Platform,
  type PlatformCapabilities,
  type RuleEvaluationResult,
  type UnifiedMessageEvent,
  type UnifiedSegment,
} from '@omni-relay/shared-types';

const START = '2026-01-01T00:00:00.000Z';

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

function makeEvent(overrides: Partial<UnifiedMessageEvent> = {}): UnifiedMessageEvent {
  return {
    eventId: 'event-1',
    platform: 'discord',
    conversation: { kind: 'group', nativeId: 'channel-1', displayName: 'General' },
    sender: { nativeId: 'user-1', displayName: 'Alice' },
    message: [{ type: 'text', text: 'ping' }],
    timestamp: START,
    mentionsBot: true,
    replyContext: {
      nativeMessageId: 'native-msg-0',
      expiresAt: '2026-01-01T00:05:00.000Z',
      canReply: true,
    },
    meta: {
      origin: 'discord',
      bridgeMessageId: 'bridge-1',
      nativeMessageId: 'native-msg-0',
      createdAt: START,
    },
    ...overrides,
  };
}

function makeRule(overrides: Partial<MessageRule> = {}): MessageRule {
  return {
    id: 'rule-1',
    name: 'Rule 1',
    enabled: true,
    priority: 10,
    platforms: ['discord'],
    conversationKinds: ['group'],
    groupIds: [],
    channelIds: [],
    userIds: [],
    trigger: { requireMention: true },
    response: { ...DEFAULT_RESPONSE_POLICY },
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

function evaluation(overrides: Partial<RuleEvaluationResult> = {}): RuleEvaluationResult {
  return {
    matched: true,
    matchedRules: ['rule-1'],
    decision: 'reply',
    reason: 'rule_matched',
    status: 'queued',
    ...overrides,
  };
}

function textSegments(count: number): UnifiedSegment[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'text' as const,
    text: `part ${index}`,
  }));
}

interface Harness {
  storage: Storage;
  clock: TestClock;
  planner: DeliveryPlanner;
}

function setup(
  options: {
    capabilities?: PlatformCapabilities;
    maxResponseSegments?: number;
  } = {},
): Harness {
  const clock = createClock();
  const storage = openStorage({ sqlitePath: ':memory:', now: clock.now });
  openStores.push(storage);
  const planner = createDeliveryPlanner({
    storage,
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES.discord,
    maxResponseSegments: options.maxResponseSegments,
    now: clock.now,
  });
  return { storage, clock, planner };
}

function planRequest(overrides: Partial<DeliveryPlanRequest> = {}): DeliveryPlanRequest {
  return {
    event: makeEvent(),
    rule: makeRule(),
    evaluation: evaluation(),
    segments: textSegments(1),
    replyToNativeMessageId: 'native-msg-0',
    ...overrides,
  };
}

describe('delivery planner', () => {
  it('ignores messages that the rule engine did not select', () => {
    const { storage, planner } = setup();
    const result = planner.plan(
      planRequest({
        evaluation: evaluation({ decision: 'ignore', status: 'ignored', reason: 'no_match' }),
      }),
    );

    expect(result).toEqual({ status: 'ignored', reason: 'no_match' });
    expect(storage.outbox.stats().queued).toBe(0);
  });

  it('passes blocked decisions through', () => {
    const { storage, planner } = setup();
    const result = planner.plan(
      planRequest({
        evaluation: evaluation({
          decision: 'blocked',
          status: 'blocked',
          reason: 'user_blacklisted',
        }),
      }),
    );

    expect(result).toEqual({ status: 'blocked', reason: 'user_blacklisted' });
    expect(storage.outbox.stats().queued).toBe(0);
  });

  it('blocks unsupported capabilities without throwing', () => {
    const { storage, planner } = setup({ capabilities: CONSERVATIVE_CAPABILITIES });
    const result = planner.plan(planRequest());

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('capability_unsupported:groupReply');
    expect(storage.outbox.stats().queued).toBe(0);
  });

  it('blocks proactive sends when the platform cannot start conversations', () => {
    const { planner } = setup({
      capabilities: { ...DEFAULT_CAPABILITIES.discord, groupProactiveSend: false },
    });
    const result = planner.plan(planRequest({ proactive: true }));

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('capability_unsupported:groupProactiveSend');
  });

  it('enforces the configured segment budget', () => {
    const { storage, planner } = setup({ maxResponseSegments: 2 });

    const overBudget = planner.plan(planRequest({ segments: textSegments(3) }));
    expect(overBudget).toEqual({ status: 'failed', reason: 'response_segment_budget_exceeded' });
    expect(storage.outbox.stats().queued).toBe(0);

    const withinBudget = planner.plan(planRequest({ segments: textSegments(2) }));
    expect(withinBudget.status).toBe('queued');
  });

  it('enforces the rule segment budget too', () => {
    const { planner } = setup();
    const rule = makeRule({ response: { ...DEFAULT_RESPONSE_POLICY, maxResponseSegments: 1 } });

    expect(planner.plan(planRequest({ rule, segments: textSegments(2) })).status).toBe('failed');
    expect(planner.plan(planRequest({ rule, segments: textSegments(1) })).status).toBe('queued');
  });

  it('applies the rule rate limit and recovers after the window', () => {
    const { storage, clock, planner } = setup();
    const rule = makeRule({
      rateLimit: { maxMessages: 1, windowSeconds: 60, scope: 'user' },
    });

    expect(planner.plan(planRequest({ rule })).status).toBe('queued');
    expect(planner.plan(planRequest({ rule }))).toEqual({
      status: 'blocked',
      reason: 'rate_limited',
    });
    expect(storage.outbox.stats().queued).toBe(1);

    clock.advance(60_000);
    expect(planner.plan(planRequest({ rule })).status).toBe('queued');
    expect(storage.outbox.stats().queued).toBe(2);
  });

  it('uses the documented scope ids for rate limit buckets', () => {
    const { storage, clock, planner } = setup();
    const rule = makeRule({
      rateLimit: { maxMessages: 1, windowSeconds: 60, scope: 'conversation' },
    });

    expect(planner.plan(planRequest({ rule })).status).toBe('queued');

    const conversationBucket = storage.rateLimits.consume(
      { scope: 'conversation', scopeId: 'discord:channel-1' },
      { maxMessages: 1, windowSeconds: 60 },
      clock.now(),
    );
    expect(conversationBucket.allowed).toBe(false);
  });

  it('queues a fully populated outbox record', () => {
    const { storage, planner } = setup();
    const result = planner.plan(planRequest({ segments: textSegments(2) }));

    expect(result.status).toBe('queued');
    expect(result.reason).toBe('queued');
    expect(result.outboxId).toBeDefined();
    if (result.outboxId === undefined) {
      return;
    }

    const record = storage.outbox.get(result.outboxId);
    expect(record).not.toBeNull();
    expect(record?.platform).toBe('discord');
    expect(record?.conversationKind).toBe('group');
    expect(record?.conversationNativeId).toBe('channel-1');
    expect(record?.senderNativeId).toBe('user-1');
    expect(record?.bridgeMessageId).toBe('bridge-1');
    expect(record?.ruleId).toBe('rule-1');
    expect(record?.payload).toEqual({
      kind: 'group',
      segments: textSegments(2),
      proactive: false,
      replyToNativeMessageId: 'native-msg-0',
      replyWindowExpiresAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('marks proactive payloads', () => {
    const { storage, planner } = setup();
    const result = planner.plan(planRequest({ proactive: true }));

    expect(result.status).toBe('queued');
    if (result.outboxId !== undefined) {
      expect(storage.outbox.get(result.outboxId)?.payload.proactive).toBe(true);
    }
  });

  it('works without a rule', () => {
    const { storage, planner } = setup();
    const result = planner.plan(planRequest({ rule: null }));

    expect(result.status).toBe('queued');
    if (result.outboxId !== undefined) {
      expect(storage.outbox.get(result.outboxId)?.ruleId).toBeUndefined();
    }
  });

  it('handles private conversations', () => {
    const { storage, planner } = setup();
    const event = makeEvent({
      conversation: { kind: 'private' as ConversationKind, nativeId: 'user-1' },
      platform: 'qq-official' as Platform,
    });
    const result = planner.plan(planRequest({ event }));

    expect(result.status).toBe('queued');
    if (result.outboxId !== undefined) {
      expect(storage.outbox.get(result.outboxId)?.conversationKind).toBe('private');
    }
  });

  it('reports failures instead of throwing when enqueueing fails', () => {
    const { storage, planner } = setup();
    storage.close();

    const result = planner.plan(planRequest());
    expect(result).toEqual({ status: 'failed', reason: 'enqueue_failed' });
  });

  it('never throws on malformed requests', () => {
    const { planner } = setup();
    expect(() => planner.plan({} as DeliveryPlanRequest)).not.toThrow();
    expect(planner.plan({} as DeliveryPlanRequest).status).toBe('failed');
  });
});
