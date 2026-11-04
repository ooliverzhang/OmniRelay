/**
 * Structural types for the subset of the Discord payloads OmniRelay consumes.
 *
 * Keeping them structural (instead of shipping a full discord.js client) means
 * the adapter stays dependency free and easy to test with fixtures.
 */

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  discriminator?: string;
  bot?: boolean;
  avatar?: string | null;
}

export interface DiscordAttachment {
  id?: string;
  url: string;
  proxy_url?: string;
  filename?: string;
  size?: number;
  width?: number | null;
  height?: number | null;
  content_type?: string | null;
}

export interface DiscordMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
  fail_if_not_exists?: boolean;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name?: string | null;
  guild_id?: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  content?: string;
  author: DiscordUser;
  timestamp: string;
  edited_timestamp?: string | null;
  attachments?: DiscordAttachment[];
  mentions?: DiscordUser[];
  referenced_message?: { id: string } | null;
  message_reference?: DiscordMessageReference | null;
  type?: number;
  channel?: DiscordChannel;
}

export interface DiscordReadyPayload {
  v: number;
  user: DiscordUser;
  session_id: string;
  guilds?: Array<{ id: string }>;
  resume_gateway_url?: string;
}

export interface DiscordGatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export const DiscordGatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const DiscordIntentBits = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const;

export interface DiscordIntentConfig {
  guilds: boolean;
  guildMessages: boolean;
  messageContent: boolean;
  directMessages: boolean;
}

export function computeIntents(intents: DiscordIntentConfig): number {
  let bits = 0;
  if (intents.guilds) {
    bits |= DiscordIntentBits.GUILDS;
  }
  if (intents.guildMessages) {
    bits |= DiscordIntentBits.GUILD_MESSAGES;
  }
  if (intents.messageContent) {
    bits |= DiscordIntentBits.MESSAGE_CONTENT;
  }
  if (intents.directMessages) {
    bits |= DiscordIntentBits.DIRECT_MESSAGES;
  }
  return bits;
}

/** Close codes that must never be retried automatically. */
export const DISCORD_FATAL_CLOSE_CODES: Record<number, string> = {
  4004: 'invalid_bot_token',
  4010: 'invalid_shard',
  4011: 'sharding_required',
  4012: 'invalid_api_version',
  4013: 'invalid_intents',
  4014: 'disallowed_intents',
};

export const DISCORD_CHANNEL_TYPE_DM = 1;
export const DISCORD_CHANNEL_TYPE_GROUP_DM = 3;
export const DISCORD_CHANNEL_TYPE_GUILD_TEXT = 0;

export function isDiscordDmChannel(type: number | undefined): boolean {
  return type === DISCORD_CHANNEL_TYPE_DM || type === DISCORD_CHANNEL_TYPE_GROUP_DM;
}
