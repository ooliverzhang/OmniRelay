import { describe, expect, it } from 'vitest';

import { testMessageRule } from '@omni-relay/rules';
import type { RuleTestInput } from '@omni-relay/shared-types';

import { makeCapabilities, makePolicy, makeRule } from './support.js';

const GROUP_INPUT: RuleTestInput = {
  platform: 'discord',
  conversationKind: 'group',
  conversationId: 'channel-1',
  userId: 'user-1',
  text: 'hello world',
  mention: true,
};

describe('testMessageRule', () => {
  it('reports a queued reply with an explanation', () => {
    const result = testMessageRule(GROUP_INPUT, [makeRule()], makeCapabilities(), {
      replyPolicy: makePolicy({ defaultMode: 'mention_only' }),
    });

    expect(result.decision).toBe('reply');
    expect(result.status).toBe('queued');
    expect(result.matchedRules).toEqual(['rule-1']);
    expect(result.appliedPolicyMode).toBe('mention_only');
    expect(result.explanation).toBe('Matched rule "Rule One" and queued a reply.');
  });

  it('explains an ignored mention-only miss', () => {
    const result = testMessageRule(
      { ...GROUP_INPUT, mention: false },
      [makeRule()],
      makeCapabilities(),
      { replyPolicy: makePolicy({ defaultMode: 'mention_only' }) },
    );

    expect(result.decision).toBe('ignore');
    expect(result.reason).toBe('mention_required_missing');
    expect(result.explanation).toContain('mention_required_missing');
  });

  it('explains a missing rule match', () => {
    const result = testMessageRule(
      GROUP_INPUT,
      [makeRule({ trigger: { textIncludes: ['absent'] } })],
      makeCapabilities(),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );

    expect(result.decision).toBe('ignore');
    expect(result.reason).toBe('no_rule_matched');
    expect(result.explanation).toContain('no_rule_matched');
  });

  it('reports the applied policy mode', () => {
    const result = testMessageRule(GROUP_INPUT, [makeRule()], makeCapabilities(), {
      replyPolicy: makePolicy({ defaultMode: 'always' }),
    });
    expect(result.appliedPolicyMode).toBe('always');
    expect(result.explanation.endsWith('.')).toBe(true);
  });

  it('includes attachments in the synthetic event', () => {
    const imageRule = makeRule({
      trigger: { messageTypes: ['image'] },
    });
    const result = testMessageRule(
      { ...GROUP_INPUT, text: '', mention: false, hasImage: true },
      [imageRule],
      makeCapabilities(),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(result.decision).toBe('reply');
  });

  it('honours a reply-to-bot trigger', () => {
    const rule = makeRule({ trigger: { requireReplyToBot: true } });
    const withoutReply = testMessageRule(GROUP_INPUT, [rule], makeCapabilities(), {
      replyPolicy: makePolicy({ defaultMode: 'always' }),
    });
    expect(withoutReply.reason).toBe('no_rule_matched');

    const withReply = testMessageRule(
      { ...GROUP_INPUT, replyToBot: true },
      [rule],
      makeCapabilities(),
      { replyPolicy: makePolicy({ defaultMode: 'always' }) },
    );
    expect(withReply.decision).toBe('reply');
  });
});
