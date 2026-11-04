import { describe, expect, it } from 'vitest';

import { matchRule } from '@omni-relay/rules';

import { makeEvent, makeRule } from './support.js';

const NOW = new Date('2026-01-02T00:00:00.000Z');

describe('matchRule', () => {
  it('matches permissive rules', () => {
    expect(matchRule(makeRule(), makeEvent(), { now: NOW })).toEqual({
      matched: true,
      reason: 'matched',
    });
  });

  it('checks the platform', () => {
    const rule = makeRule({ platforms: ['qq-official'] });
    expect(matchRule(rule, makeEvent(), { now: NOW })).toEqual({
      matched: false,
      reason: 'platform_mismatch',
    });
  });

  it('checks the conversation kind', () => {
    const rule = makeRule({ conversationKinds: ['private'] });
    expect(matchRule(rule, makeEvent(), { now: NOW }).reason).toBe('conversation_kind_mismatch');
  });

  it('checks group, channel and user allowlists', () => {
    expect(matchRule(makeRule({ groupIds: ['other'] }), makeEvent(), { now: NOW }).reason).toBe(
      'group_not_allowlisted',
    );
    expect(matchRule(makeRule({ channelIds: ['other'] }), makeEvent(), { now: NOW }).reason).toBe(
      'channel_not_allowlisted',
    );
    expect(matchRule(makeRule({ userIds: ['other'] }), makeEvent(), { now: NOW }).reason).toBe(
      'user_not_allowlisted',
    );
  });

  it('checks trigger allowlists', () => {
    expect(
      matchRule(makeRule({ trigger: { groupAllowlist: ['other'] } }), makeEvent(), { now: NOW })
        .reason,
    ).toBe('group_not_allowlisted');
    expect(
      matchRule(makeRule({ trigger: { channelAllowlist: ['other'] } }), makeEvent(), { now: NOW })
        .reason,
    ).toBe('channel_not_allowlisted');
    expect(
      matchRule(makeRule({ trigger: { userAllowlist: ['other'] } }), makeEvent(), { now: NOW })
        .reason,
    ).toBe('user_not_allowlisted');
  });

  it('requires a mention when configured', () => {
    const rule = makeRule({ trigger: { requireMention: true } });
    expect(matchRule(rule, makeEvent({ mentionsBot: false }), { now: NOW }).reason).toBe(
      'mention_required',
    );
    expect(matchRule(rule, makeEvent({ mentionsBot: true }), { now: NOW }).matched).toBe(true);
  });

  it('requires a reply when configured', () => {
    const rule = makeRule({ trigger: { requireReplyToBot: true } });
    expect(matchRule(rule, makeEvent(), { now: NOW }).reason).toBe('reply_required');
    expect(
      matchRule(
        rule,
        makeEvent({ replyContext: { nativeMessageId: 'native-0', canReply: true } }),
        { now: NOW },
      ).matched,
    ).toBe(true);
  });

  it('matches text prefixes and substrings case sensitively', () => {
    const prefixed = makeRule({ trigger: { textPrefix: 'hello' } });
    expect(matchRule(prefixed, makeEvent(), { now: NOW }).matched).toBe(true);
    expect(
      matchRule(prefixed, makeEvent({ message: [{ type: 'text', text: 'Hello world' }] }), {
        now: NOW,
      }).reason,
    ).toBe('text_prefix_mismatch');

    const includes = makeRule({ trigger: { textIncludes: ['world', 'nope'] } });
    expect(matchRule(includes, makeEvent(), { now: NOW }).matched).toBe(true);
    expect(
      matchRule(includes, makeEvent({ message: [{ type: 'text', text: 'hello there' }] }), {
        now: NOW,
      }).reason,
    ).toBe('text_includes_mismatch');
  });

  it('applies text regexes', () => {
    const rule = makeRule({ trigger: { textRegex: '^hello' } });
    expect(matchRule(rule, makeEvent(), { now: NOW }).matched).toBe(true);
    expect(
      matchRule(rule, makeEvent({ message: [{ type: 'text', text: 'bye' }] }), { now: NOW }).reason,
    ).toBe('text_regex_mismatch');
  });

  it('reports invalid regexes instead of throwing', () => {
    const rule = makeRule({ trigger: { textRegex: '([' } });
    expect(matchRule(rule, makeEvent(), { now: NOW })).toEqual({
      matched: false,
      reason: 'text_regex_invalid',
    });
  });

  it('checks message kinds', () => {
    const rule = makeRule({ trigger: { messageTypes: ['image'] } });
    expect(matchRule(rule, makeEvent(), { now: NOW }).reason).toBe('message_type_mismatch');
    expect(
      matchRule(
        rule,
        makeEvent({ message: [{ type: 'image', url: 'https://cdn.example/a.png' }] }),
        { now: NOW },
      ).matched,
    ).toBe(true);
  });

  it('enforces privateOnly and groupOnly', () => {
    const privateOnly = makeRule({ trigger: { privateOnly: true } });
    expect(matchRule(privateOnly, makeEvent(), { now: NOW }).reason).toBe('private_only_violation');

    const groupOnly = makeRule({ trigger: { groupOnly: true } });
    const channelEvent = makeEvent({ conversation: { kind: 'channel', nativeId: 'channel-1' } });
    expect(matchRule(groupOnly, channelEvent, { now: NOW }).reason).toBe('group_only_violation');
  });

  it('ignores bot authors unless explicitly allowed', () => {
    const event = makeEvent({ sender: { nativeId: 'user-1', isBot: true } });
    expect(matchRule(makeRule(), event, { now: NOW })).toEqual({
      matched: false,
      reason: 'author_is_bot',
    });
    expect(
      matchRule(makeRule({ trigger: { ignoreBots: false } }), event, { now: NOW }).matched,
    ).toBe(true);
  });

  it('matches text built from text segments only', () => {
    const rule = makeRule({ trigger: { textIncludes: ['hi there'] } });
    const event = makeEvent({
      message: [
        { type: 'text', text: 'hi ' },
        { type: 'image', url: 'https://cdn.example/a.png' },
        { type: 'text', text: 'there' },
      ],
    });
    expect(matchRule(rule, event, { now: NOW }).matched).toBe(true);
  });
});
