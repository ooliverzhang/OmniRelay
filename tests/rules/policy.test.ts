import { describe, expect, it } from 'vitest';

import { evaluateReplyPolicy } from '@omni-relay/rules';

import { makeEvent, makePolicy } from './support.js';

describe('evaluateReplyPolicy', () => {
  it('blocks everything when disabled', () => {
    const verdict = evaluateReplyPolicy(makeEvent(), makePolicy({ defaultMode: 'disabled' }));
    expect(verdict).toEqual({ allowed: false, reason: 'reply_policy_disabled' });
  });

  it('allows private chats in private_only mode', () => {
    const verdict = evaluateReplyPolicy(
      makeEvent({ conversation: { kind: 'private', nativeId: 'user-1' } }),
      makePolicy({ defaultMode: 'private_only' }),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('blocks groups in private_only mode', () => {
    const verdict = evaluateReplyPolicy(
      makeEvent({ conversation: { kind: 'group', nativeId: 'channel-1' } }),
      makePolicy({ defaultMode: 'private_only' }),
    );
    expect(verdict).toEqual({ allowed: false, reason: 'private_only_violation' });
  });

  it('requires a mention in groups for mention_only mode', () => {
    const policy = makePolicy({ defaultMode: 'mention_only' });
    const silent = evaluateReplyPolicy(makeEvent({ mentionsBot: false }), policy);
    expect(silent).toEqual({ allowed: false, reason: 'mention_required_missing' });

    const mentioned = evaluateReplyPolicy(makeEvent({ mentionsBot: true }), policy);
    expect(mentioned.allowed).toBe(true);
  });

  it('accepts a reply to the bot in place of a mention', () => {
    const event = makeEvent({
      mentionsBot: false,
      replyContext: { nativeMessageId: 'native-0', canReply: true },
    });
    const verdict = evaluateReplyPolicy(event, makePolicy({ defaultMode: 'mention_only' }));
    expect(verdict.allowed).toBe(true);
  });

  it('lets private chats bypass the mention requirement by default', () => {
    const event = makeEvent({ conversation: { kind: 'private', nativeId: 'user-1' } });
    const verdict = evaluateReplyPolicy(event, makePolicy({ defaultMode: 'mention_only' }));
    expect(verdict.allowed).toBe(true);
  });

  it('honours a strict private mention requirement', () => {
    const event = makeEvent({ conversation: { kind: 'private', nativeId: 'user-1' } });
    const verdict = evaluateReplyPolicy(
      event,
      makePolicy({ defaultMode: 'mention_only', allowPrivateWithoutMention: false }),
    );
    expect(verdict).toEqual({ allowed: false, reason: 'mention_required_missing' });
  });

  it('matches whitelist entries by native user id and platform key', () => {
    const policy = (ids: string[]): ReturnType<typeof makePolicy> =>
      makePolicy({ defaultMode: 'whitelist', whitelistUserIds: ids });

    expect(evaluateReplyPolicy(makeEvent(), policy(['user-1'])).allowed).toBe(true);
    expect(evaluateReplyPolicy(makeEvent(), policy(['discord:user:user-1'])).allowed).toBe(true);
    expect(evaluateReplyPolicy(makeEvent(), policy(['someone-else']))).toEqual({
      allowed: false,
      reason: 'whitelist_mismatch',
    });
  });

  it('matches whitelist conversations by native id', () => {
    const policy = makePolicy({ defaultMode: 'whitelist', whitelistGroupIds: ['channel-1'] });
    expect(evaluateReplyPolicy(makeEvent(), policy).allowed).toBe(true);
  });

  it('always allows in always mode', () => {
    expect(evaluateReplyPolicy(makeEvent(), makePolicy({ defaultMode: 'always' })).allowed).toBe(
      true,
    );
  });
});
