import {
  BridgeError,
  type ConversationKind,
  type OutgoingMessage,
  type Platform,
  type UnifiedMessageEvent,
  type UnifiedSegment,
} from '@omni-relay/shared-types';
import { normalizeDiscordMessage } from '@omni-relay/core';

import type { DiscordRestClient } from './rest.js';
import type { DiscordGateway, DiscordGatewayStatus } from './gateway.js';
import { downloadMedia } from './media.js';
import {
  isDiscordDmChannel,
  type DiscordChannel,
  type DiscordMessage,
} from './types.js';

export interface DiscordAdapterLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Mirrors `SendTarget` from the queue package to keep adapters dependency-free. */
export interface SendTarget {
  platform: Platform;
  conversationKind: ConversationKind;
  conversationNativeId: string;
  senderNativeId: string;
  replyToNativeMessageId?: string | undefined;
  replyWindowExpiresAt?: string | undefined;
}

export interface SendResult {
  nativeMessageId: string;
}

export interface DiscordAdapterOptions {
  rest: DiscordRestClient;
  gateway?: DiscordGateway | undefined;
  guildAllowlist?: string[] | undefined;
  channelAllowlist?: string[] | undefined;
  logger?: DiscordAdapterLogger | undefined;
  /** Used for attachment downloads; defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
  mediaMaxBytes?: number | undefined;
  mediaTimeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface DiscordAdapterSettings {
  guildAllowlist?: string[] | undefined;
  channelAllowlist?: string[] | undefined;
}

const MAX_CONTENT_LENGTH = 2_000;
const CONTENT_CHUNK_LENGTH = 1_900;

interface PreparedAttachment {
  url: string;
  filename: string;
}

interface PreparedContent {
  content: string;
  attachments: PreparedAttachment[];
}

/**
 * Discord adapter: gateway events in, REST calls out.
 *
 * Secrets are never read here; the caller resolves the bot token from the
 * environment and hands the adapter an already authorised REST client.
 */
export class DiscordAdapter {
  readonly platform: Platform = 'discord';

  private readonly rest: DiscordRestClient;
  private readonly gateway: DiscordGateway | undefined;
  private guildAllowlist: string[];
  private channelAllowlist: string[];
  private readonly logger: DiscordAdapterLogger | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly mediaMaxBytes: number | undefined;
  private readonly mediaTimeoutMs: number | undefined;
  private readonly now: () => Date;
  private readonly dmChannelCache = new Map<string, string>();
  private botUserId: string | null = null;
  private lastEventAt: string | null = null;

  constructor(options: DiscordAdapterOptions) {
    this.rest = options.rest;
    this.gateway = options.gateway;
    this.guildAllowlist = options.guildAllowlist ?? [];
    this.channelAllowlist = options.channelAllowlist ?? [];
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl;
    this.mediaMaxBytes = options.mediaMaxBytes;
    this.mediaTimeoutMs = options.mediaTimeoutMs;
    this.now = options.now ?? (() => new Date());
  }

  getBotUserId(): string | null {
    return this.botUserId ?? this.gateway?.getStatus().userId ?? null;
  }

  /** Applies allowlist changes made from the console without a restart. */
  applySettings(settings: DiscordAdapterSettings): void {
    if (settings.guildAllowlist) {
      this.guildAllowlist = [...settings.guildAllowlist];
    }
    if (settings.channelAllowlist) {
      this.channelAllowlist = [...settings.channelAllowlist];
    }
  }

  setBotUserId(userId: string | null): void {
    this.botUserId = userId;
  }

  getStatus(): DiscordGatewayStatus | { state: 'disabled' } {
    if (!this.gateway) {
      return { state: 'disabled' };
    }
    return this.gateway.getStatus();
  }

  getLastEventAt(): string | null {
    return this.lastEventAt;
  }

  isConversationAllowed(guildId: string | null | undefined, channelId: string): boolean {
    if (this.channelAllowlist.length > 0 && !this.channelAllowlist.includes(channelId)) {
      return false;
    }
    if (guildId && this.guildAllowlist.length > 0 && !this.guildAllowlist.includes(guildId)) {
      return false;
    }
    return true;
  }

  /**
   * Converts a `MESSAGE_CREATE` dispatch payload into a unified event.
   * Returns `null` when the message is filtered out by the allowlists.
   */
  handleDispatch(eventName: string, data: unknown): UnifiedMessageEvent | null {
    if (eventName !== 'MESSAGE_CREATE') {
      return null;
    }
    const message = data as DiscordMessage | undefined;
    if (!message || typeof message.id !== 'string' || typeof message.channel_id !== 'string') {
      return null;
    }

    this.lastEventAt = this.nowIso();
    const guildId = message.guild_id ?? null;
    if (!this.isConversationAllowed(guildId, message.channel_id)) {
      this.logger?.debug('discord message filtered by allowlist', { channelId: message.channel_id });
      return null;
    }

    const isDm = guildId === null;
    const channelType = message.channel?.type;
    const channelKind: 'dm' | 'guild' = isDm || isDiscordDmChannel(channelType) ? 'dm' : 'guild';

    return normalizeDiscordMessage(
      {
        id: message.id,
        channelId: message.channel_id,
        guildId,
        channelKind,
        channelName: message.channel?.name ?? null,
        content: message.content ?? '',
        author: {
          id: message.author.id,
          username: message.author.username ?? null,
          globalName: message.author.global_name ?? null,
          bot: message.author.bot ?? false,
          avatarUrl: message.author.avatar ?? null,
        },
        timestamp: message.timestamp,
        isBotMentioned: this.detectBotMention(message),
        mentions: (message.mentions ?? []).map((mention) => ({
          id: mention.id,
          username: mention.username ?? null,
        })),
        attachments: (message.attachments ?? []).map((attachment) => ({
          id: attachment.id,
          url: attachment.url,
          filename: attachment.filename ?? null,
          size: attachment.size ?? null,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          contentType: attachment.content_type ?? null,
        })),
        referencedMessageId: message.referenced_message?.id ?? message.message_reference?.message_id ?? null,
        botUserId: this.getBotUserId(),
      },
      { now: this.now },
    );
  }

  /** Sends a normalized message through the Discord REST API. */
  async send(message: OutgoingMessage, target: SendTarget): Promise<SendResult> {
    const prepared = this.prepareContent(message.segments);
    if (prepared.content.length === 0 && prepared.attachments.length === 0) {
      throw new BridgeError({
        code: 'invalid_config',
        message: 'discord_empty_message',
        retryable: false,
      });
    }

    const channelId = await this.resolveChannelId(target);
    const files = await this.downloadAttachments(prepared.attachments);
    const chunks = splitContent(prepared.content);

    let lastId = '';
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? '';
      const isLastChunk = index === chunks.length - 1;
      const result = await this.rest.createMessage(channelId, {
        ...(chunk.length > 0 ? { content: chunk } : {}),
        ...(index === 0 && target.replyToNativeMessageId
          ? { message_reference: { message_id: target.replyToNativeMessageId, fail_if_not_exists: false } }
          : {}),
        ...(isLastChunk && files.length > 0 ? { files } : {}),
        allowed_mentions: { parse: ['users'], replied_user: false },
      });
      lastId = result.id;
    }

    return { nativeMessageId: lastId };
  }

  private async resolveChannelId(target: SendTarget): Promise<string> {
    if (target.conversationKind !== 'private') {
      return target.conversationNativeId;
    }
    const cached = this.dmChannelCache.get(target.conversationNativeId);
    if (cached) {
      return cached;
    }
    const channel: DiscordChannel = await this.rest.openDirectMessage(target.conversationNativeId);
    this.dmChannelCache.set(target.conversationNativeId, channel.id);
    return channel.id;
  }

  private detectBotMention(message: DiscordMessage): boolean {
    const botId = this.getBotUserId();
    if (!botId) {
      return false;
    }
    if ((message.mentions ?? []).some((mention) => mention.id === botId)) {
      return true;
    }
    return (message.content ?? '').includes(`<@${botId}>`) || (message.content ?? '').includes(`<@!${botId}>`);
  }

  private prepareContent(segments: readonly UnifiedSegment[]): PreparedContent {
    let content = '';
    const attachments: PreparedAttachment[] = [];

    for (const segment of segments) {
      switch (segment.type) {
        case 'text':
          content += segment.text;
          break;
        case 'mention':
          content += `<@${segment.userId}>`;
          break;
        case 'image':
          attachments.push({
            url: segment.url,
            filename: segment.filename ?? defaultFilename(segment.url, 'png'),
          });
          break;
        case 'file':
          attachments.push({ url: segment.url, filename: segment.filename });
          break;
        case 'reply':
          break;
        default:
          break;
      }
    }

    return { content, attachments };
  }

  private async downloadAttachments(
    attachments: readonly PreparedAttachment[],
  ): Promise<Array<{ filename: string; data: Uint8Array; contentType: string }>> {
    const files: Array<{ filename: string; data: Uint8Array; contentType: string }> = [];
    for (const attachment of attachments) {
      const downloaded = await downloadMedia(attachment.url, attachment.filename, {
        ...(this.mediaMaxBytes === undefined ? {} : { maxBytes: this.mediaMaxBytes }),
        ...(this.mediaTimeoutMs === undefined ? {} : { timeoutMs: this.mediaTimeoutMs }),
        ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      });
      files.push({
        filename: attachment.filename,
        data: downloaded.data,
        contentType: downloaded.contentType,
      });
    }
    return files;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function splitContent(content: string): string[] {
  if (content.length === 0) {
    return [''];
  }
  if (content.length <= MAX_CONTENT_LENGTH) {
    return [content];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    chunks.push(content.slice(cursor, cursor + CONTENT_CHUNK_LENGTH));
    cursor += CONTENT_CHUNK_LENGTH;
  }
  return chunks;
}

function defaultFilename(url: string, extension: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').pop();
    if (last && last.includes('.')) {
      return decodeURIComponent(last);
    }
  } catch {
    // ignore malformed urls
  }
  return `attachment.${extension}`;
}

export { isDiscordDmChannel };
