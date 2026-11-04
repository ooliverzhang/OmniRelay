import type {
  UnifiedConversation,
  UnifiedMessageEvent,
  UnifiedSegment,
  UnifiedSender,
} from '@omni-relay/shared-types';

import { createBridgeMessageId, createEventId } from './ids.js';
import { toIsoTimestamp } from './timestamp.js';

/** Clock injection so adapters and tests can pin `meta.createdAt`. */
export interface NormalizeOptions {
  now?: () => Date;
}

export interface DiscordAuthorShape {
  id: string;
  username?: string | null;
  globalName?: string | null;
  bot?: boolean | null;
  avatarUrl?: string | null;
}

export interface DiscordAttachmentShape {
  id?: string;
  url: string;
  filename?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  contentType?: string | null;
}

export interface DiscordInboundShape {
  id: string;
  channelId: string;
  guildId?: string | null;
  channelKind: 'dm' | 'guild';
  channelName?: string | null;
  content: string;
  author: DiscordAuthorShape;
  timestamp: string | number;
  isBotMentioned?: boolean;
  mentions?: Array<{ id: string; username?: string | null }>;
  attachments?: DiscordAttachmentShape[];
  referencedMessageId?: string | null;
  botUserId?: string | null;
  eventId?: string;
}

/** Matches Discord user mentions (`<@id>`, `<@!id>`) and channel mentions (`<#id>`). */
const MENTION_PATTERN = /<@!?(\d+)>|<#(\d+)>/g;

const IMAGE_PREFIX = 'image/';

type ImageSegment = Extract<UnifiedSegment, { type: 'image' }>;
type FileSegment = Extract<UnifiedSegment, { type: 'file' }>;
type MentionSegment = Extract<UnifiedSegment, { type: 'mention' }>;

/** Converts a raw Discord gateway message into the unified model. */
export function normalizeDiscordMessage(
  input: DiscordInboundShape,
  options: NormalizeOptions = {},
): UnifiedMessageEvent {
  const now = options.now ?? (() => new Date());
  const conversation = buildConversation(input);
  const event: UnifiedMessageEvent = {
    eventId: input.eventId ?? createEventId(),
    platform: 'discord',
    conversation,
    sender: buildSender(input.author),
    message: buildSegments(input),
    timestamp: toIsoTimestamp(input.timestamp),
    mentionsBot: detectMentionsBot(input),
    meta: {
      origin: 'discord',
      bridgeMessageId: createBridgeMessageId('discord', input.id),
      nativeMessageId: input.id,
      createdAt: now().toISOString(),
    },
  };
  const referencedMessageId = input.referencedMessageId;
  if (
    referencedMessageId !== undefined &&
    referencedMessageId !== null &&
    referencedMessageId.length > 0
  ) {
    event.replyContext = { nativeMessageId: referencedMessageId, canReply: true };
  }
  return event;
}

function buildConversation(input: DiscordInboundShape): UnifiedConversation {
  if (input.channelKind === 'dm') {
    return { kind: 'private', nativeId: input.author.id };
  }
  const conversation: UnifiedConversation = { kind: 'group', nativeId: input.channelId };
  if (input.channelName !== undefined && input.channelName !== null) {
    conversation.displayName = input.channelName;
  }
  if (input.guildId !== undefined && input.guildId !== null) {
    conversation.parentNativeId = input.guildId;
  }
  return conversation;
}

function buildSender(author: DiscordAuthorShape): UnifiedSender {
  const sender: UnifiedSender = { nativeId: author.id, isBot: author.bot === true };
  const displayName = author.globalName ?? author.username;
  if (displayName !== undefined && displayName !== null) {
    sender.displayName = displayName;
  }
  if (author.username !== undefined && author.username !== null) {
    sender.username = author.username;
  }
  if (author.avatarUrl !== undefined && author.avatarUrl !== null) {
    sender.avatarUrl = author.avatarUrl;
  }
  return sender;
}

function buildSegments(input: DiscordInboundShape): UnifiedSegment[] {
  const segments: UnifiedSegment[] = [];
  pushContentSegments(segments, input.content, input.mentions);
  const attachments = input.attachments ?? [];
  attachments.forEach((attachment, index) => {
    segments.push(attachmentSegment(attachment, index));
  });
  return segments;
}

function attachmentSegment(attachment: DiscordAttachmentShape, index: number): UnifiedSegment {
  if ((attachment.contentType ?? '').startsWith(IMAGE_PREFIX)) {
    const image: ImageSegment = { type: 'image', url: attachment.url };
    if (attachment.filename !== undefined && attachment.filename !== null) {
      image.filename = attachment.filename;
    }
    if (attachment.width !== undefined && attachment.width !== null) {
      image.width = attachment.width;
    }
    if (attachment.height !== undefined && attachment.height !== null) {
      image.height = attachment.height;
    }
    return image;
  }
  const file: FileSegment = {
    type: 'file',
    url: attachment.url,
    filename: attachment.filename ?? String(attachment.id ?? index),
  };
  if (attachment.size !== undefined && attachment.size !== null) {
    file.size = attachment.size;
  }
  return file;
}

/**
 * Splits message content into text and mention segments.
 *
 * Mention markers never leak into text segments; `<@id>`, `<@!id>` and `<#id>`
 * are all represented as mention segments.
 */
function pushContentSegments(
  segments: UnifiedSegment[],
  content: string,
  mentions: DiscordInboundShape['mentions'],
): void {
  if (content.length === 0) {
    return;
  }
  let cursor = 0;
  MENTION_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: 'text', text: content.slice(cursor, index) });
    }
    const mentionedId = match[1] ?? match[2];
    if (mentionedId !== undefined) {
      const username = mentions?.find((mention) => mention.id === mentionedId)?.username;
      const mention: MentionSegment = { type: 'mention', userId: mentionedId };
      if (username !== undefined && username !== null) {
        mention.displayName = username;
      }
      segments.push(mention);
    }
    cursor = index + match[0].length;
  }
  if (cursor < content.length) {
    segments.push({ type: 'text', text: content.slice(cursor) });
  }
}

function detectMentionsBot(input: DiscordInboundShape): boolean {
  if (typeof input.isBotMentioned === 'boolean') {
    return input.isBotMentioned;
  }
  const botUserId = input.botUserId;
  if (botUserId === undefined || botUserId === null || botUserId.length === 0) {
    return false;
  }
  if (input.mentions?.some((mention) => mention.id === botUserId) === true) {
    return true;
  }
  return input.content.includes(`<@${botUserId}>`) || input.content.includes(`<@!${botUserId}>`);
}
