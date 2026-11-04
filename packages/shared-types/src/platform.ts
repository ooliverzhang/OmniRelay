/**
 * Platform identity model shared by every layer of OmniRelay.
 *
 * The bridge never exposes a native platform id as a OneBot id directly; the
 * native id is always paired with its {@link Platform} discriminator first.
 */

export const PLATFORMS = ['discord', 'qq-official'] as const;

export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  discord: 'Discord',
  'qq-official': 'QQ 官方机器人',
};

export const CONVERSATION_KINDS = ['private', 'group', 'channel'] as const;

export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/**
 * Explicit, declarative platform capability matrix.
 *
 * A capability that cannot be verified for a platform must be reported as
 * `false` (unsupported) instead of being guessed.
 */
export interface PlatformCapabilities {
  /** Can the bot receive direct/private messages? */
  privateReceive: boolean;
  /** Can the bot reply inside an existing private conversation? */
  privateReply: boolean;
  /** Can the bot start a private conversation without an inbound message? */
  privateProactiveSend: boolean;
  /** Can the bot receive every group message (not only mentions)? */
  groupReceive: boolean;
  /** Can the bot receive group messages that mention it? */
  groupMentionReceive: boolean;
  /** Can the bot reply inside an existing group conversation? */
  groupReply: boolean;
  /** Can the bot push a message into a group without an inbound message? */
  groupProactiveSend: boolean;
  /** Can the bot broadcast to every conversation at once? */
  broadcast: boolean;
}

export type CapabilityFlag = keyof PlatformCapabilities;

export const CAPABILITY_FLAGS = [
  'privateReceive',
  'privateReply',
  'privateProactiveSend',
  'groupReceive',
  'groupMentionReceive',
  'groupReply',
  'groupProactiveSend',
  'broadcast',
] as const satisfies readonly CapabilityFlag[];

/**
 * Conservative baseline: everything that is not explicitly known to work is
 * reported as unsupported.
 */
export const CONSERVATIVE_CAPABILITIES: PlatformCapabilities = {
  privateReceive: false,
  privateReply: false,
  privateProactiveSend: false,
  groupReceive: false,
  groupMentionReceive: false,
  groupReply: false,
  groupProactiveSend: false,
  broadcast: false,
};

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

export function isConversationKind(value: unknown): value is ConversationKind {
  return typeof value === 'string' && (CONVERSATION_KINDS as readonly string[]).includes(value);
}
