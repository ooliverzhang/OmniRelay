/**
 * Structural types for the QQ official bot (v2) API used by OmniRelay.
 *
 * Reference: https://bot.q.qq.com/wiki/develop/api-v2/
 * Only the fields the bridge reads or writes are modelled.
 */

export interface QqAuthor {
  id?: string;
  user_openid?: string;
  member_openid?: string;
  member_role?: 'owner' | 'admin' | 'member' | null;
  union_openid?: string;
}

export interface QqAttachment {
  id?: string;
  url: string;
  filename?: string | null;
  content_type?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  /**
   * Temporary CDN urls expire; the platform may report the deadline under
   * either key. Preserved verbatim so the bridge can forward it to OneBot.
   */
  url_expires_at?: string | null;
  url_expire_at?: string | null;
}

export interface QqC2CMessageCreate {
  id: string;
  content: string;
  timestamp: string | number;
  author: QqAuthor;
  attachments?: QqAttachment[];
  msg_seq?: number;
  message_scene?: { source?: string; ext?: string[] };
}

export interface QqGroupAtMessageCreate {
  id: string;
  content: string;
  timestamp: string | number;
  group_openid: string;
  group_id?: string;
  author: QqAuthor;
  attachments?: QqAttachment[];
  msg_seq?: number;
}

export interface QqReadyPayload {
  session_id?: string;
  user?: { id?: string; username?: string; bot?: boolean };
}

export interface QqGatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
  id?: string | null;
}

export const QqGatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** `GROUP_AND_C2C_EVENT` (1 << 25) is required for C2C + group messages. */
export const QQ_INTENT_GROUP_AND_C2C_EVENT = 1 << 25;
export const QQ_INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
export const QQ_INTENT_PUBLIC_MESSAGES = 1 << 12;

export const QQ_MESSAGE_TYPE = {
  TEXT: 0,
  MARKDOWN: 2,
  ARK: 3,
  EMBED: 4,
  MEDIA: 7,
} as const;

export const QQ_FILE_TYPE = {
  IMAGE: 1,
  VIDEO: 2,
  AUDIO: 3,
  FILE: 4,
} as const;

export const QQ_EVENT_NAMES = {
  C2C_MESSAGE_CREATE: 'C2C_MESSAGE_CREATE',
  GROUP_AT_MESSAGE_CREATE: 'GROUP_AT_MESSAGE_CREATE',
  GROUP_MESSAGE_CREATE: 'GROUP_MESSAGE_CREATE',
  READY: 'READY',
  RESUMED: 'RESUMED',
} as const;

/** Text payload limit; longer content is split into several messages. */
export const QQ_MAX_CONTENT_LENGTH = 1_500;
