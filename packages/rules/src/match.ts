import type {
  MessageKind,
  MessageRule,
  UnifiedMessageEvent,
  UnifiedSegment,
} from '@omni-relay/shared-types';
import { segmentsToPlainText } from '@omni-relay/shared-types';

const textRegexCache = new Map<string, RegExp | null>();

export interface RuleMatchOutcome {
  matched: boolean;
  reason: string;
}

/** Compiles and memoizes a rule regex; `null` marks an invalid pattern. */
export function compileTextRegex(source: string): RegExp | null {
  const cached = textRegexCache.get(source);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(source);
  } catch {
    compiled = null;
  }
  textRegexCache.set(source, compiled);
  return compiled;
}

/** True when the event is a reply to an earlier message (presumed to be the bot). */
export function isReplyToBot(event: UnifiedMessageEvent): boolean {
  const context = event.replyContext;
  if (context === undefined) {
    return false;
  }
  return context.nativeMessageId !== undefined || context.eventId !== undefined;
}

/**
 * Classifies the message by segment composition.
 *
 * Kept local to this package: `@omni-relay/rules` must not depend on
 * `@omni-relay/core` (package manifests are frozen), so the tiny classifier is
 * mirrored here with identical semantics.
 */
export function messageKindOf(segments: readonly UnifiedSegment[]): MessageKind {
  const kinds = new Set<'text' | 'image' | 'file'>();
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
      case 'mention':
        kinds.add('text');
        break;
      case 'image':
        kinds.add('image');
        break;
      case 'file':
        kinds.add('file');
        break;
      case 'reply':
        break;
    }
  }
  if (kinds.size === 0) {
    return 'text';
  }
  if (kinds.size > 1) {
    return 'mixed';
  }
  const [only] = kinds;
  return only ?? 'text';
}

function includesAny(source: readonly string[] | undefined, value: string): boolean {
  if (source === undefined || source.length === 0) {
    return true;
  }
  return source.includes(value);
}

/**
 * Evaluates a single rule's filters against an event.
 *
 * Returns the first failing filter as a machine-readable reason; `matched` is
 * true with reason `matched` when every filter passes. `now` is accepted for
 * signature stability with the scheduling layer.
 */
export function matchRule(
  rule: MessageRule,
  event: UnifiedMessageEvent,
  _options: { now: Date },
): RuleMatchOutcome {
  const trigger = rule.trigger;
  if (!rule.platforms.includes(event.platform)) {
    return { matched: false, reason: 'platform_mismatch' };
  }
  if (!rule.conversationKinds.includes(event.conversation.kind)) {
    return { matched: false, reason: 'conversation_kind_mismatch' };
  }
  if (!includesAny(rule.groupIds, event.conversation.nativeId)) {
    return { matched: false, reason: 'group_not_allowlisted' };
  }
  if (!includesAny(rule.channelIds, event.conversation.nativeId)) {
    return { matched: false, reason: 'channel_not_allowlisted' };
  }
  if (!includesAny(rule.userIds, event.sender.nativeId)) {
    return { matched: false, reason: 'user_not_allowlisted' };
  }
  if (!includesAny(trigger.groupAllowlist, event.conversation.nativeId)) {
    return { matched: false, reason: 'group_not_allowlisted' };
  }
  if (!includesAny(trigger.channelAllowlist, event.conversation.nativeId)) {
    return { matched: false, reason: 'channel_not_allowlisted' };
  }
  if (!includesAny(trigger.userAllowlist, event.sender.nativeId)) {
    return { matched: false, reason: 'user_not_allowlisted' };
  }
  if (trigger.requireMention === true && !event.mentionsBot) {
    return { matched: false, reason: 'mention_required' };
  }
  if (trigger.requireReplyToBot === true && !isReplyToBot(event)) {
    return { matched: false, reason: 'reply_required' };
  }
  const text = segmentsToPlainText(event.message);
  if (trigger.textPrefix !== undefined && !text.startsWith(trigger.textPrefix)) {
    return { matched: false, reason: 'text_prefix_mismatch' };
  }
  if (
    trigger.textIncludes !== undefined &&
    trigger.textIncludes.length > 0 &&
    !trigger.textIncludes.some((needle) => text.includes(needle))
  ) {
    return { matched: false, reason: 'text_includes_mismatch' };
  }
  if (trigger.textRegex !== undefined) {
    const regex = compileTextRegex(trigger.textRegex);
    if (regex === null) {
      return { matched: false, reason: 'text_regex_invalid' };
    }
    if (!regex.test(text)) {
      return { matched: false, reason: 'text_regex_mismatch' };
    }
  }
  if (
    trigger.messageTypes !== undefined &&
    trigger.messageTypes.length > 0 &&
    !trigger.messageTypes.includes(messageKindOf(event.message))
  ) {
    return { matched: false, reason: 'message_type_mismatch' };
  }
  if (trigger.privateOnly === true && event.conversation.kind !== 'private') {
    return { matched: false, reason: 'private_only_violation' };
  }
  if (trigger.groupOnly === true && event.conversation.kind !== 'group') {
    return { matched: false, reason: 'group_only_violation' };
  }
  if (trigger.ignoreBots !== false && event.sender.isBot === true) {
    return { matched: false, reason: 'author_is_bot' };
  }
  return { matched: true, reason: 'matched' };
}
