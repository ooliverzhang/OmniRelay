import type {
  UnifiedConversation,
  UnifiedMessageEvent,
  UnifiedSegment,
  UnifiedSender,
} from '@omni-relay/shared-types';

import { qqDedupeKey } from './dedupe.js';
import { createBridgeMessageId, createEventId } from './ids.js';
import type { NormalizeOptions } from './normalize-discord.js';
import { toIsoTimestamp } from './timestamp.js';

export interface QqAttachmentShape {
  url: string;
  filename?: string | null;
  contentType?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  urlExpiresAt?: string | null;
}

export interface QqInboundShape {
  id: string;
  msgSeq?: string | number | null;
  kind: 'c2c' | 'group';
  groupOpenId?: string | null;
  userOpenId: string;
  content: string;
  timestamp: string | number;
  attachments?: QqAttachmentShape[];
  memberRole?: 'owner' | 'admin' | 'member' | null;
  mentionsBot?: boolean;
  userName?: string | null;
  groupName?: string | null;
  eventId?: string;
}

const IMAGE_PREFIX = 'image/';

type ImageSegment = Extract<UnifiedSegment, { type: 'image' }>;
type FileSegment = Extract<UnifiedSegment, { type: 'file' }>;

/** Converts a raw QQ official bot message into the unified model. */
export function normalizeQqMessage(
  input: QqInboundShape,
  options: NormalizeOptions = {},
): UnifiedMessageEvent {
  const now = options.now ?? (() => new Date());
  const conversation = buildConversation(input);
  const sender: UnifiedSender = {
    nativeId: input.userOpenId,
    role: input.memberRole ?? 'unknown',
  };
  if (input.userName !== undefined && input.userName !== null) {
    sender.displayName = input.userName;
  }
  const segments: UnifiedSegment[] = [];
  if (input.content.length > 0) {
    segments.push({ type: 'text', text: input.content });
  }
  const attachments = input.attachments ?? [];
  attachments.forEach((attachment, index) => {
    segments.push(attachmentSegment(attachment, index));
  });
  return {
    eventId: input.eventId ?? createEventId(),
    platform: 'qq-official',
    conversation,
    sender,
    message: segments,
    timestamp: toIsoTimestamp(input.timestamp),
    mentionsBot: input.mentionsBot ?? false,
    meta: {
      origin: 'qq-official',
      bridgeMessageId: createBridgeMessageId('qq-official', qqDedupeKey(input.id, input.msgSeq)),
      nativeMessageId: input.id,
      createdAt: now().toISOString(),
    },
  };
}

function buildConversation(input: QqInboundShape): UnifiedConversation {
  if (input.kind === 'c2c') {
    const conversation: UnifiedConversation = { kind: 'private', nativeId: input.userOpenId };
    if (input.userName !== undefined && input.userName !== null) {
      conversation.displayName = input.userName;
    }
    return conversation;
  }
  const groupOpenId = input.groupOpenId;
  if (groupOpenId === undefined || groupOpenId === null || groupOpenId.length === 0) {
    throw new Error('qq group message requires groupOpenId');
  }
  const conversation: UnifiedConversation = { kind: 'group', nativeId: groupOpenId };
  if (input.groupName !== undefined && input.groupName !== null) {
    conversation.displayName = input.groupName;
  }
  return conversation;
}

function attachmentSegment(attachment: QqAttachmentShape, index: number): UnifiedSegment {
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
    if (attachment.urlExpiresAt !== undefined && attachment.urlExpiresAt !== null) {
      image.urlExpiresAt = attachment.urlExpiresAt;
    }
    return image;
  }
  const file: FileSegment = {
    type: 'file',
    url: attachment.url,
    filename: attachment.filename ?? deriveFilename(attachment.url, index),
  };
  if (attachment.size !== undefined && attachment.size !== null) {
    file.size = attachment.size;
  }
  if (attachment.urlExpiresAt !== undefined && attachment.urlExpiresAt !== null) {
    file.urlExpiresAt = attachment.urlExpiresAt;
  }
  return file;
}

function deriveFilename(url: string, index: number): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname
      .split('/')
      .filter((part) => part.length > 0)
      .pop();
    if (last !== undefined && last.length > 0) {
      return decodeURIComponent(last);
    }
  } catch {
    // Malformed urls fall through to the positional fallback name.
  }
  return `file-${index}`;
}
