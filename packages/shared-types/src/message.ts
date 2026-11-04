import type { ConversationKind, Platform } from './platform.js';

/**
 * Unified, platform-agnostic message segments.
 *
 * Adapters must convert native payloads into these segments before the rest of
 * the bridge sees them, and the OneBot layer converts them back out.
 */
export type UnifiedSegment =
  | { type: 'text'; text: string }
  | { type: 'mention'; userId: string; displayName?: string }
  | {
      type: 'image';
      url: string;
      filename?: string;
      width?: number;
      height?: number;
      /** Wall-clock expiry of a temporary CDN url, ISO-8601. */
      urlExpiresAt?: string;
    }
  | {
      type: 'file';
      url: string;
      filename: string;
      size?: number;
      urlExpiresAt?: string;
    }
  | { type: 'reply'; messageId: string };

export type UnifiedSegmentType = UnifiedSegment['type'];

export interface UnifiedConversation {
  kind: ConversationKind;
  /** Native identifier: Discord channel id, QQ group_openid, QQ user_openid, ... */
  nativeId: string;
  displayName?: string;
  /** Present for group/channel conversations that belong to a guild. */
  parentNativeId?: string;
}

export type SenderRole = 'owner' | 'admin' | 'member' | 'unknown';

export interface UnifiedSender {
  nativeId: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
  role?: SenderRole;
  isBot?: boolean;
}

export interface UnifiedReplyContext {
  nativeMessageId?: string;
  eventId?: string;
  /** Passive replies are only allowed until this instant (ISO-8601). */
  expiresAt?: string;
  canReply: boolean;
}

export type MessageOrigin = Platform | 'onebot';

export interface MessageMeta {
  origin: MessageOrigin;
  bridgeMessageId: string;
  nativeMessageId?: string;
  createdAt: string;
}

/**
 * The single internal representation that adapters produce and the OneBot
 * layer consumes.
 */
export interface UnifiedMessageEvent {
  eventId: string;
  platform: Platform;
  conversation: UnifiedConversation;
  sender: UnifiedSender;
  message: UnifiedSegment[];
  /** ISO-8601 timestamp of the platform event. */
  timestamp: string;
  /** True when the message explicitly mentions the bot. */
  mentionsBot: boolean;
  replyContext?: UnifiedReplyContext;
  meta: MessageMeta;
  raw?: unknown;
}

/** Outgoing, already normalized message that adapters translate to native calls. */
export interface OutgoingMessage {
  kind: ConversationKind;
  segments: UnifiedSegment[];
  /** Native message id that this message replies to, when the platform needs it. */
  replyToNativeMessageId?: string;
  /** True when the message is not a response to an inbound message. */
  proactive: boolean;
  /** Expiry of the passive-reply window inherited from the inbound event. */
  replyWindowExpiresAt?: string;
}

export const TEXT_SEGMENT = (text: string): UnifiedSegment => ({ type: 'text', text });

export function isTextSegment(
  segment: UnifiedSegment,
): segment is Extract<UnifiedSegment, { type: 'text' }> {
  return segment.type === 'text';
}

/** Concatenates the text segments of a message; used for rule matching and logs. */
export function segmentsToPlainText(segments: readonly UnifiedSegment[]): string {
  let out = '';
  for (const segment of segments) {
    if (segment.type === 'text') {
      out += segment.text;
    }
  }
  return out;
}

export function hasSegmentOfType(
  segments: readonly UnifiedSegment[],
  type: UnifiedSegmentType,
): boolean {
  return segments.some((segment) => segment.type === type);
}

export function toIsoString(value: Date | string | number): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  return new Date(value).toISOString();
}
