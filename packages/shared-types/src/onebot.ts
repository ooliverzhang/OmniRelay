/**
 * OneBot 11 wire types.
 *
 * Only the subset that OmniRelay implements (plus a permissive escape hatch for
 * unknown segments) is modelled here.
 */

export const ONEBOT_PROTOCOL_VERSION = 'v11';

export const ONEBOT_APP_NAME = 'OmniRelay';

/** Response status values defined by the OneBot 11 specification. */
export const ONEBOT_STATUS = {
  OK: 'ok',
  ASYNC: 'async',
  FAILED: 'failed',
} as const;

export type OneBotStatus = (typeof ONEBOT_STATUS)[keyof typeof ONEBOT_STATUS];

/** retcode values used by OmniRelay. */
export const ONEBOT_RETCODE = {
  OK: 0,
  /** Accepted into the outbox, delivery happens asynchronously. */
  ASYNC: 1,
  /** Platform rejected the message permanently. */
  PLATFORM_REJECTED: 100,
  BAD_REQUEST: 1400,
  UNAUTHORIZED: 1403,
  NOT_FOUND: 1404,
  CAPABILITY_UNSUPPORTED: 1405,
  RATE_LIMITED: 1429,
  TIMEOUT: 1504,
  INTERNAL_ERROR: 1500,
} as const;

export interface OneBotTextSegment {
  type: 'text';
  data: { text: string };
}

export interface OneBotAtSegment {
  type: 'at';
  data: { qq: string | number; name?: string };
}

export interface OneBotImageSegment {
  type: 'image';
  data: {
    file: string;
    url?: string;
    sub_type?: number;
    file_size?: number;
    /**
     * Non-standard extension: wall-clock expiry (ISO-8601) of a temporary CDN
     * url, so hosts know to download the media before it disappears.
     */
    url_expires_at?: string;
  };
}

export interface OneBotFileSegment {
  type: 'file';
  data: {
    file: string;
    url?: string;
    name?: string;
    file_size?: number;
    /** Non-standard extension, see {@link OneBotImageSegment}. */
    url_expires_at?: string;
  };
}

export interface OneBotReplySegment {
  type: 'reply';
  data: { id: string };
}

/** Unknown segment: preserved verbatim but never forwarded blindly. */
export interface OneBotUnknownSegment {
  type: string;
  data: Record<string, unknown>;
}

export type OneBotSegment =
  | OneBotTextSegment
  | OneBotAtSegment
  | OneBotImageSegment
  | OneBotFileSegment
  | OneBotReplySegment
  | OneBotUnknownSegment;

export type OneBotMessageType = 'private' | 'group';

export interface OneBotSender {
  user_id?: number;
  nickname?: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
}

export interface OneBotMessageEvent {
  time: number;
  self_id: number;
  post_type: 'message';
  message_type: OneBotMessageType;
  sub_type: 'friend' | 'group' | 'normal' | 'anonymous' | 'notice';
  message_id: number | string;
  user_id: number;
  group_id?: number;
  message: OneBotSegment[];
  raw_message?: string;
  font?: number;
  sender?: OneBotSender;
}

export interface OneBotMetaEvent {
  time: number;
  self_id: number;
  post_type: 'meta_event';
  meta_event_type: 'lifecycle' | 'heartbeat';
  sub_type?: string;
  status?: Record<string, unknown>;
  interval?: number;
}

export type OneBotEvent = OneBotMessageEvent | OneBotMetaEvent;

export interface OneBotActionRequest {
  action: string;
  params?: Record<string, unknown>;
  echo?: string | number;
}

export interface OneBotActionResponse {
  status: OneBotStatus;
  retcode: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: string | number;
}

export interface OneBotLoginInfo {
  user_id: number;
  nickname: string;
}

export interface OneBotVersionInfo {
  app_name: string;
  app_version: string;
  protocol_version: string;
  app_full_name?: string;
}

export interface OneBotStatusInfo {
  online: boolean;
  good: boolean;
}

export interface OneBotGroupInfo {
  group_id: number;
  group_name: string;
  member_count?: number;
  max_member_count?: number;
}

export interface OneBotGroupMemberInfo {
  group_id: number;
  user_id: number;
  nickname: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
  join_time?: number;
  last_sent_time?: number;
}

export interface OneBotStrangerInfo {
  user_id: number;
  nickname: string;
  sex?: 'male' | 'female' | 'unknown';
  age?: number;
}

export interface OneBotSendMessageResult {
  message_id: string;
}

/** OneBot string message format, used by clients that send `message` as text. */
export const ONEBOT_CQ_ESCAPE = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/;

export function isOneBotActionRequest(value: unknown): value is OneBotActionRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { action?: unknown };
  return typeof candidate.action === 'string' && candidate.action.length > 0;
}
