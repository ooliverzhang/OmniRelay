import type {
  CapabilityFlag,
  MessageRule,
  MessageStatus,
  PlatformCapabilities,
  ReplyPolicyConfig,
  RuleDecision,
  RuleEvaluationResult,
  RulesEngineConfig,
  UnifiedMessageEvent,
} from '@omni-relay/shared-types';

import { matchRule } from './match.js';
import { evaluateReplyPolicy } from './policy.js';
import { isWithinSchedule } from './schedule.js';

export interface RuleMatchDetail {
  ruleId: string;
  name: string;
  matched: boolean;
  reason: string;
}

export interface RuleSetEvaluation {
  result: RuleEvaluationResult;
  details: RuleMatchDetail[];
}

export interface RuleEngineOptions {
  replyPolicy: ReplyPolicyConfig;
  engine?: RulesEngineConfig | undefined;
  now?: Date | undefined;
  isRateLimited?: ((rule: MessageRule) => boolean) | undefined;
}

interface CapabilityCheck {
  ok: boolean;
  flag: CapabilityFlag;
}

function makeResult(
  decision: RuleDecision,
  status: MessageStatus,
  reason: string,
): RuleEvaluationResult {
  return { matched: false, matchedRules: [], decision, reason, status };
}

function makeDetail(rule: MessageRule, matched: boolean, reason: string): RuleMatchDetail {
  return { ruleId: rule.id, name: rule.name, matched, reason };
}

function attachMatches(
  outcome: RuleEvaluationResult,
  matchedRules: readonly string[],
): RuleEvaluationResult {
  return {
    matched: true,
    matchedRules: [...matchedRules],
    decision: outcome.decision,
    reason: outcome.reason,
    status: outcome.status,
  };
}

function compareRules(left: MessageRule, right: MessageRule): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  const leftCreated = Date.parse(left.createdAt);
  const rightCreated = Date.parse(right.createdAt);
  const leftValid = !Number.isNaN(leftCreated);
  const rightValid = !Number.isNaN(rightCreated);
  if (leftValid && rightValid && leftCreated !== rightCreated) {
    return leftCreated - rightCreated;
  }
  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return 0;
}

function checkCapability(
  event: UnifiedMessageEvent,
  capabilities: PlatformCapabilities,
): CapabilityCheck {
  if (event.conversation.kind === 'private') {
    return capabilities.privateReceive
      ? { ok: true, flag: 'privateReceive' }
      : { ok: false, flag: 'privateReceive' };
  }
  const flag: CapabilityFlag = event.mentionsBot ? 'groupMentionReceive' : 'groupReceive';
  return capabilities[flag] ? { ok: true, flag } : { ok: false, flag };
}

function buildOutcome(
  rule: MessageRule,
  isRateLimited: ((rule: MessageRule) => boolean) | undefined,
): RuleEvaluationResult {
  if (isRateLimited?.(rule) === true) {
    return {
      matched: true,
      matchedRules: [rule.id],
      decision: 'blocked',
      reason: `rule_rate_limited:${rule.id}`,
      status: 'blocked',
    };
  }
  if (rule.response.enabled === false) {
    return {
      matched: true,
      matchedRules: [rule.id],
      decision: 'ignore',
      reason: `rule_response_disabled:${rule.id}`,
      status: 'ignored',
    };
  }
  return {
    matched: true,
    matchedRules: [rule.id],
    decision: 'reply',
    reason: `matched:${rule.id}`,
    status: 'queued',
  };
}

/** Evaluates an inbound event against the policy and the rule set. */
export function evaluateRuleSet(
  event: UnifiedMessageEvent,
  rules: MessageRule[],
  capabilities: PlatformCapabilities,
  options: RuleEngineOptions,
): RuleSetEvaluation {
  const details: RuleMatchDetail[] = [];
  const now = options.now ?? new Date();

  if (event.sender.isBot === true) {
    return { result: makeResult('ignore', 'ignored', 'bot_message_ignored'), details };
  }

  const capability = checkCapability(event, capabilities);
  if (!capability.ok) {
    return {
      result: makeResult('blocked', 'blocked', `capability_unsupported:${capability.flag}`),
      details,
    };
  }

  if (options.engine?.enabled === false) {
    return { result: makeResult('ignore', 'ignored', 'rules_engine_disabled'), details };
  }

  const policy = evaluateReplyPolicy(event, options.replyPolicy);
  if (!policy.allowed) {
    const reason = policy.reason ?? 'reply_policy_disabled';
    const decision: RuleDecision =
      reason === 'reply_policy_disabled' || reason === 'mention_required_missing'
        ? 'ignore'
        : 'blocked';
    return {
      result: makeResult(decision, decision === 'ignore' ? 'ignored' : 'blocked', reason),
      details,
    };
  }

  const ordered = [...rules].sort(compareRules);
  const stopOnFirstMatch = options.engine?.stopOnFirstMatch ?? true;
  const matchedRules: string[] = [];
  let firstReply: RuleEvaluationResult | null = null;
  let firstOutcome: RuleEvaluationResult | null = null;

  for (const rule of ordered) {
    if (rule.enabled === false) {
      details.push(makeDetail(rule, false, 'rule_disabled'));
      continue;
    }
    if (!isWithinSchedule(rule.schedule, now)) {
      details.push(makeDetail(rule, false, 'schedule_inactive'));
      continue;
    }
    const match = matchRule(rule, event, { now });
    if (!match.matched) {
      details.push(makeDetail(rule, false, match.reason));
      continue;
    }
    matchedRules.push(rule.id);
    details.push(makeDetail(rule, true, 'matched'));
    const outcome = buildOutcome(rule, options.isRateLimited);
    if (outcome.decision === 'reply' && firstReply === null) {
      firstReply = outcome;
    }
    if (firstOutcome === null) {
      firstOutcome = outcome;
    }
    if (stopOnFirstMatch) {
      return { result: attachMatches(outcome, matchedRules), details };
    }
  }

  const chosen = firstReply ?? firstOutcome;
  if (chosen === null) {
    return { result: makeResult('ignore', 'ignored', 'no_rule_matched'), details };
  }
  return { result: attachMatches(chosen, matchedRules), details };
}

/** Convenience wrapper returning only the decision/status result. */
export function evaluateMessageRule(
  event: UnifiedMessageEvent,
  rules: MessageRule[],
  capabilities: PlatformCapabilities,
  options: RuleEngineOptions,
): RuleEvaluationResult {
  return evaluateRuleSet(event, rules, capabilities, options).result;
}
