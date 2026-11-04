import { describe, expect, it } from 'vitest';

import { evaluateMessageRule, evaluateRuleSet } from '@omni-relay/rules';

import { makeCapabilities, makeEngine, makeEvent, makePolicy, makeRule } from './support.js';

describe('evaluateRuleSet', () => {
  it('ignores bot messages before touching the rules', () => {
    const evaluation = evaluateRuleSet(
      makeEvent({ sender: { nativeId: 'bot-1', isBot: true } }),
      [makeRule()],
      makeCapabilities(),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(evaluation.result).toEqual({
      matched: false,
      matchedRules: [],
      decision: 'ignore',
      reason: 'bot_message_ignored',
      status: 'ignored',
    });
    expect(evaluation.details).toEqual([]);
  });

  it('blocks when the platform cannot receive plain group messages', () => {
    const evaluation = evaluateRuleSet(
      makeEvent({ mentionsBot: false }),
      [makeRule()],
      makeCapabilities({ groupReceive: false }),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(evaluation.result.decision).toBe('blocked');
    expect(evaluation.result.reason).toBe('capability_unsupported:groupReceive');
    expect(evaluation.result.status).toBe('blocked');
  });

  it('uses the mention capability for mentioned group messages', () => {
    const evaluation = evaluateRuleSet(
      makeEvent({ mentionsBot: true }),
      [makeRule()],
      makeCapabilities({ groupMentionReceive: false }),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(evaluation.result.reason).toBe('capability_unsupported:groupMentionReceive');
  });

  it('blocks private messages when private receive is unsupported', () => {
    const evaluation = evaluateRuleSet(
      makeEvent({ conversation: { kind: 'private', nativeId: 'user-1' } }),
      [makeRule()],
      makeCapabilities({ privateReceive: false }),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(evaluation.result.reason).toBe('capability_unsupported:privateReceive');
  });

  it('stops when the engine is disabled', () => {
    const evaluation = evaluateRuleSet(makeEvent(), [makeRule()], makeCapabilities(), {
      replyPolicy: makePolicy({ defaultMode: 'always' }),
      engine: makeEngine({ enabled: false }),
    });
    expect(evaluation.result).toMatchObject({
      decision: 'ignore',
      reason: 'rules_engine_disabled',
      status: 'ignored',
    });
  });

  it('applies the global policy before the rules', () => {
    const evaluation = evaluateRuleSet(
      makeEvent({ mentionsBot: false }),
      [makeRule()],
      makeCapabilities(),
      {
        replyPolicy: makePolicy({ defaultMode: 'mention_only' }),
      },
    );
    expect(evaluation.result).toMatchObject({
      decision: 'ignore',
      reason: 'mention_required_missing',
      matchedRules: [],
    });
  });

  it('blocks on a private_only policy violation', () => {
    const evaluation = evaluateRuleSet(makeEvent(), [makeRule()], makeCapabilities(), {
      replyPolicy: makePolicy({ defaultMode: 'private_only' }),
    });
    expect(evaluation.result).toMatchObject({
      decision: 'blocked',
      reason: 'private_only_violation',
      status: 'blocked',
    });
  });

  it('queues a reply for the highest priority match', () => {
    const evaluation = evaluateRuleSet(
      makeEvent(),
      [
        makeRule({ id: 'low', name: 'Low', priority: 1 }),
        makeRule({ id: 'high', name: 'High', priority: 10 }),
      ],
      makeCapabilities(),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(evaluation.result).toEqual({
      matched: true,
      matchedRules: ['high'],
      decision: 'reply',
      reason: 'matched:high',
      status: 'queued',
    });
    expect(evaluation.details).toEqual([
      { ruleId: 'high', name: 'High', matched: true, reason: 'matched' },
    ]);
  });

  it('orders equal priorities by creation time', () => {
    const evaluation = evaluateRuleSet(
      makeEvent(),
      [
        makeRule({ id: 'later', priority: 5, createdAt: '2026-01-02T00:00:00.000Z' }),
        makeRule({ id: 'earlier', priority: 5, createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      makeCapabilities(),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(evaluation.result.reason).toBe('matched:earlier');
  });

  it('collects every match when stopOnFirstMatch is false but replies once', () => {
    const evaluation = evaluateRuleSet(
      makeEvent(),
      [makeRule({ id: 'high', priority: 10 }), makeRule({ id: 'low', priority: 1 })],
      makeCapabilities(),
      {
        replyPolicy: makePolicy({ defaultMode: 'always' }),
        engine: makeEngine({ stopOnFirstMatch: false }),
      },
    );
    expect(evaluation.result).toEqual({
      matched: true,
      matchedRules: ['high', 'low'],
      decision: 'reply',
      reason: 'matched:high',
      status: 'queued',
    });
    expect(evaluation.details.map((detail) => detail.ruleId)).toEqual(['high', 'low']);
  });

  it('falls through to the first reply when an earlier match disables responses', () => {
    const evaluation = evaluateRuleSet(
      makeEvent(),
      [
        makeRule({
          id: 'high',
          priority: 10,
          response: { ...makeRule().response, enabled: false },
        }),
        makeRule({ id: 'low', priority: 1 }),
      ],
      makeCapabilities(),
      {
        replyPolicy: makePolicy({ defaultMode: 'always' }),
        engine: makeEngine({ stopOnFirstMatch: false }),
      },
    );
    expect(evaluation.result.decision).toBe('reply');
    expect(evaluation.result.reason).toBe('matched:low');
    expect(evaluation.result.matchedRules).toEqual(['high', 'low']);
  });

  it('blocks when the matched rule is rate limited', () => {
    const evaluation = evaluateRuleSet(makeEvent(), [makeRule()], makeCapabilities(), {
      replyPolicy: makePolicy({ defaultMode: 'always' }),
      isRateLimited: (rule) => rule.id === 'rule-1',
    });
    expect(evaluation.result).toEqual({
      matched: true,
      matchedRules: ['rule-1'],
      decision: 'blocked',
      reason: 'rule_rate_limited:rule-1',
      status: 'blocked',
    });
  });

  it('ignores when the matched rule disables responses', () => {
    const rule = makeRule({ response: { ...makeRule().response, enabled: false } });
    const evaluation = evaluateRuleSet(makeEvent(), [rule], makeCapabilities(), {
      replyPolicy: makePolicy({ defaultMode: 'always' }),
    });
    expect(evaluation.result).toMatchObject({
      decision: 'ignore',
      reason: 'rule_response_disabled:rule-1',
      status: 'ignored',
    });
  });

  it('reports no_rule_matched when nothing matches', () => {
    const evaluation = evaluateRuleSet(
      makeEvent(),
      [makeRule({ trigger: { textIncludes: ['absent'] } })],
      makeCapabilities(),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(evaluation.result).toEqual({
      matched: false,
      matchedRules: [],
      decision: 'ignore',
      reason: 'no_rule_matched',
      status: 'ignored',
    });
    expect(evaluation.details).toEqual([
      { ruleId: 'rule-1', name: 'Rule One', matched: false, reason: 'text_includes_mismatch' },
    ]);
  });

  it('records disabled rules and inactive schedules as details', () => {
    const evaluation = evaluateRuleSet(
      makeEvent(),
      [
        makeRule({ id: 'off', enabled: false }),
        makeRule({
          id: 'scheduled',
          priority: -1,
          schedule: { weekdays: [7] },
        }),
      ],
      makeCapabilities(),
      {
        replyPolicy: makePolicy({ defaultMode: 'always' }),
        now: new Date('2026-01-02T00:00:00.000Z'), // Friday
      },
    );
    expect(evaluation.result.reason).toBe('no_rule_matched');
    expect(evaluation.details).toEqual([
      { ruleId: 'off', name: 'Rule One', matched: false, reason: 'rule_disabled' },
      { ruleId: 'scheduled', name: 'Rule One', matched: false, reason: 'schedule_inactive' },
    ]);
  });

  it('treats a missing engine config as enabled', () => {
    const evaluation = evaluateRuleSet(makeEvent(), [makeRule()], makeCapabilities(), {
      replyPolicy: makePolicy({ defaultMode: 'always' }),
    });
    expect(evaluation.result.decision).toBe('reply');
  });
});

describe('evaluateMessageRule', () => {
  it('returns the same result as evaluateRuleSet', () => {
    const options = { replyPolicy: makePolicy({ defaultMode: 'always' }) };
    const event = makeEvent();
    const result = evaluateMessageRule(event, [makeRule()], makeCapabilities(), options);
    const evaluation = evaluateRuleSet(event, [makeRule()], makeCapabilities(), options);
    expect(result).toEqual(evaluation.result);
  });
});
