import { randomUUID } from 'node:crypto';

import type {
  MessageRule,
  PlatformCapabilities,
  RuleEvaluationResult,
  RuleTestInput,
  RuleTestResult,
  UnifiedMessageEvent,
  UnifiedSegment,
} from '@omni-relay/shared-types';

import { evaluateRuleSet } from './engine.js';
import type { RuleEngineOptions } from './engine.js';

const TEST_IMAGE_URL = 'https://example.invalid/test-image.png';
const TEST_FILE_URL = 'https://example.invalid/test-file.bin';

function toIsoTimestamp(value: string | undefined, fallback: Date): string {
  if (value === undefined) {
    return fallback.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

/** Builds a synthetic inbound event for the offline rule tester. */
export function buildEventFromTestInput(
  input: RuleTestInput,
  now: Date = new Date(),
): UnifiedMessageEvent {
  const conversationId =
    input.conversationId.length > 0 ? input.conversationId : 'test-conversation';
  const senderId = input.userId.length > 0 ? input.userId : 'test-user';
  const timestamp = toIsoTimestamp(input.timestamp, now);

  const segments: UnifiedSegment[] = [];
  if (input.text.length > 0) {
    segments.push({ type: 'text', text: input.text });
  }
  if (input.mention) {
    segments.push({ type: 'mention', userId: 'test-self' });
  }
  if (input.hasImage === true) {
    segments.push({ type: 'image', url: TEST_IMAGE_URL, filename: 'test-image.png' });
  }
  if (input.hasFile === true) {
    segments.push({ type: 'file', url: TEST_FILE_URL, filename: 'test-file.bin' });
  }

  const event: UnifiedMessageEvent = {
    eventId: `evt_${randomUUID()}`,
    platform: input.platform,
    conversation: { kind: input.conversationKind, nativeId: conversationId },
    sender: { nativeId: senderId },
    message: segments,
    timestamp,
    mentionsBot: input.mention,
    meta: {
      origin: 'onebot',
      bridgeMessageId: `brg_test_${randomUUID()}`,
      nativeMessageId: 'test-message',
      createdAt: now.toISOString(),
    },
  };
  if (input.replyToBot === true) {
    event.replyContext = { nativeMessageId: 'test-reply-message', canReply: true };
  }
  return event;
}

function explain(result: RuleEvaluationResult, ruleName: string | undefined): string {
  switch (result.decision) {
    case 'reply':
      return ruleName !== undefined && ruleName.length > 0
        ? `Matched rule "${ruleName}" and queued a reply.`
        : 'Matched a rule and queued a reply.';
    case 'blocked':
      return `Blocked by the rule engine: ${result.reason}.`;
    case 'ignore':
      return `Ignored by the rule engine: ${result.reason}.`;
  }
}

/** Runs the offline rule tester: builds an event, evaluates it, and explains the result. */
export function testMessageRule(
  input: RuleTestInput,
  rules: MessageRule[],
  capabilities: PlatformCapabilities,
  options: Omit<RuleEngineOptions, 'isRateLimited'>,
): RuleTestResult {
  const now = options.now ?? new Date();
  const event = buildEventFromTestInput(input, now);
  const evaluation = evaluateRuleSet(event, rules, capabilities, {
    replyPolicy: options.replyPolicy,
    engine: options.engine,
    now,
  });
  const firstRuleId = evaluation.result.matchedRules[0];
  const ruleName = rules.find((rule) => rule.id === firstRuleId)?.name;
  return {
    ...evaluation.result,
    explanation: explain(evaluation.result, ruleName),
    appliedPolicyMode: options.replyPolicy.defaultMode,
  };
}
