import type { ReplyPolicyConfig, UnifiedMessageEvent } from '@omni-relay/shared-types';

import { isReplyToBot } from './match.js';

export interface ReplyPolicyEvaluation {
  allowed: boolean;
  reason: string | null;
}

function allowed(): ReplyPolicyEvaluation {
  return { allowed: true, reason: null };
}

function denied(reason: string): ReplyPolicyEvaluation {
  return { allowed: false, reason };
}

/**
 * Applies the global reply policy before any rule is evaluated.
 *
 * A positive decision here only means "rules may be consulted"; a rule still
 * has to match before a reply is queued.
 */
export function evaluateReplyPolicy(
  event: UnifiedMessageEvent,
  policy: ReplyPolicyConfig,
): ReplyPolicyEvaluation {
  switch (policy.defaultMode) {
    case 'disabled':
      return denied('reply_policy_disabled');
    case 'private_only':
      return event.conversation.kind === 'private' ? allowed() : denied('private_only_violation');
    case 'whitelist': {
      const senderKeys = [event.sender.nativeId, `${event.platform}:user:${event.sender.nativeId}`];
      const userAllowed = senderKeys.some((key) => policy.whitelistUserIds.includes(key));
      const conversationAllowed = policy.whitelistGroupIds.includes(event.conversation.nativeId);
      return userAllowed || conversationAllowed ? allowed() : denied('whitelist_mismatch');
    }
    case 'mention_only': {
      if (event.mentionsBot || isReplyToBot(event)) {
        return allowed();
      }
      const exemptWithoutMention =
        event.conversation.kind === 'private'
          ? policy.allowPrivateWithoutMention
          : event.conversation.kind === 'group'
            ? policy.allowGroupWithoutMention
            : policy.allowChannelWithoutMention;
      return exemptWithoutMention ? allowed() : denied('mention_required_missing');
    }
    case 'always':
      return allowed();
  }
}
