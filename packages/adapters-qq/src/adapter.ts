import {
  BridgeError,
  type ConversationKind,
  type OutgoingMessage,
  type Platform,
  type UnifiedMessageEvent,
  type UnifiedSegment,
} from '@omni-relay/shared-types';
import { normalizeQqMessage } from '@omni-relay/core';

import type { QqRestClient } from './rest.js';
import type { QqGatewayStatus } from './gateway.js';
import {
  QQ_EVENT_NAMES,
  QQ_FILE_TYPE,
  QQ_MAX_CONTENT_LENGTH,
  type QqAttachment,
  type QqC2CMessageCreate,
  type QqGroupAtMessageCreate,
} from './types.js';

export interface QqAdapterLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

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

export interface QqGatewayLike {
  getStatus(): QqGatewayStatus;
  connect(): void;
  close(): Promise<void>;
}

export interface QqAdapterOptions {
  rest: QqRestClient;
  gateway?: QqGatewayLike | undefined;
  groupAllowlist?: string[] | undefined;
  allowProactivePrivate?: boolean | undefined;
  allowProactiveGroup?: boolean | undefined;
  receiveAllGroupMessages?: boolean | undefined;
  logger?: QqAdapterLogger | undefined;
  fetchImpl?: typeof fetch | undefined;
  mediaMaxBytes?: number | undefined;
  mediaTimeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
  /** Passive reply window advertised by the platform. */
  passiveReplyWindowSeconds?: number | undefined;
}

export interface QqAdapterSettings {
  groupAllowlist?: string[] | undefined;
  allowProactivePrivate?: boolean | undefined;
  allowProactiveGroup?: boolean | undefined;
  receiveAllGroupMessages?: boolean | undefined;
}

interface PreparedAttachment {
  url: string;
  filename: string;
  isImage: boolean;
}

const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const CONTENT_CHUNK_LENGTH = 1_200;

/**
 * QQ official bot adapter.
 *
 * QQ distinguishes passive replies (bound to an inbound `msg_id`, limited
 * window) from proactive messages (quota limited and toggleable by the user);
 * both gates are enforced here and surfaced as permanent bridge errors.
 */
export class QqAdapter {
  readonly platform: Platform = 'qq-official';

  private readonly rest: QqRestClient;
  private readonly gateway: QqGatewayLike | undefined;
  private groupAllowlist: string[];
  private allowProactivePrivate: boolean;
  private allowProactiveGroup: boolean;
  private receiveAllGroupMessages: boolean;
  private readonly logger: QqAdapterLogger | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly mediaMaxBytes: number;
  private readonly mediaTimeoutMs: number;
  private readonly now: () => Date;
  private readonly passiveReplyWindowSeconds: number;
  private lastEventAt: string | null = null;

  constructor(options: QqAdapterOptions) {
    this.rest = options.rest;
    this.gateway = options.gateway;
    this.groupAllowlist = options.groupAllowlist ?? [];
    this.allowProactivePrivate = options.allowProactivePrivate ?? true;
    this.allowProactiveGroup = options.allowProactiveGroup ?? false;
    this.receiveAllGroupMessages = options.receiveAllGroupMessages ?? false;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl;
    this.mediaMaxBytes = options.mediaMaxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    this.mediaTimeoutMs = options.mediaTimeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
    this.passiveReplyWindowSeconds = options.passiveReplyWindowSeconds ?? 300;
  }

  getStatus(): QqGatewayStatus | { state: 'disabled' } {
    if (!this.gateway) {
      return { state: 'disabled' };
    }
    return this.gateway.getStatus();
  }

  getLastEventAt(): string | null {
    return this.lastEventAt;
  }

  isGroupAllowed(groupOpenId: string): boolean {
    if (this.groupAllowlist.length === 0) {
      return true;
    }
    return this.groupAllowlist.includes(groupOpenId);
  }

  /** Applies settings changed from the console without a restart. */
  applySettings(settings: QqAdapterSettings): void {
    if (settings.groupAllowlist) {
      this.groupAllowlist = [...settings.groupAllowlist];
    }
    if (settings.allowProactivePrivate !== undefined) {
      this.allowProactivePrivate = settings.allowProactivePrivate;
    }
    if (settings.allowProactiveGroup !== undefined) {
      this.allowProactiveGroup = settings.allowProactiveGroup;
    }
    if (settings.receiveAllGroupMessages !== undefined) {
      this.receiveAllGroupMessages = settings.receiveAllGroupMessages;
    }
  }

  /** Converts a Gateway dispatch payload into a unified event. */
  handleDispatch(eventName: string, data: unknown): UnifiedMessageEvent | null {
    if (eventName === QQ_EVENT_NAMES.C2C_MESSAGE_CREATE) {
      const message = data as QqC2CMessageCreate | undefined;
      if (!message || typeof message.id !== 'string') {
        return null;
      }
      this.lastEventAt = this.now().toISOString();
      const expiresAt = new Date(
        this.now().getTime() + this.passiveReplyWindowSeconds * 1000,
      ).toISOString();
      const event = normalizeQqMessage(
        {
          id: message.id,
          msgSeq: message.msg_seq ?? null,
          kind: 'c2c',
          userOpenId: message.author?.user_openid ?? message.author?.id ?? '',
          content: message.content ?? '',
          timestamp: message.timestamp,
          attachments: mapAttachments(message.attachments),
          mentionsBot: false,
        },
        { now: this.now },
      );
      return {
        ...event,
        replyContext: {
          nativeMessageId: message.id,
          canReply: true,
          expiresAt,
        },
      };
    }

    if (eventName === QQ_EVENT_NAMES.GROUP_AT_MESSAGE_CREATE) {
      const message = data as QqGroupAtMessageCreate | undefined;
      if (!message || typeof message.id !== 'string' || typeof message.group_openid !== 'string') {
        return null;
      }
      if (!this.isGroupAllowed(message.group_openid)) {
        this.logger?.debug('qq group message filtered by allowlist', {
          group: message.group_openid,
        });
        return null;
      }
      this.lastEventAt = this.now().toISOString();
      const expiresAt = new Date(
        this.now().getTime() + this.passiveReplyWindowSeconds * 1000,
      ).toISOString();
      const event = normalizeQqMessage(
        {
          id: message.id,
          msgSeq: message.msg_seq ?? null,
          kind: 'group',
          groupOpenId: message.group_openid,
          userOpenId: message.author?.member_openid ?? message.author?.id ?? '',
          content: message.content ?? '',
          timestamp: message.timestamp,
          attachments: mapAttachments(message.attachments),
          memberRole: message.author?.member_role ?? null,
          mentionsBot: true,
        },
        { now: this.now },
      );
      return {
        ...event,
        mentionsBot: true,
        replyContext: {
          nativeMessageId: message.id,
          canReply: true,
          expiresAt,
        },
      };
    }

    if (eventName === QQ_EVENT_NAMES.GROUP_MESSAGE_CREATE) {
      if (!this.receiveAllGroupMessages) {
        return null;
      }
      const message = data as QqGroupAtMessageCreate | undefined;
      if (!message || typeof message.id !== 'string' || typeof message.group_openid !== 'string') {
        return null;
      }
      if (!this.isGroupAllowed(message.group_openid)) {
        return null;
      }
      this.lastEventAt = this.now().toISOString();
      return normalizeQqMessage(
        {
          id: message.id,
          msgSeq: message.msg_seq ?? null,
          kind: 'group',
          groupOpenId: message.group_openid,
          userOpenId: message.author?.member_openid ?? message.author?.id ?? '',
          content: message.content ?? '',
          timestamp: message.timestamp,
          attachments: mapAttachments(message.attachments),
          memberRole: message.author?.member_role ?? null,
          mentionsBot: false,
        },
        { now: this.now },
      );
    }

    return null;
  }

  async send(message: OutgoingMessage, target: SendTarget): Promise<SendResult> {
    const kind = target.conversationKind === 'private' ? 'private' : 'group';
    const passive = Boolean(target.replyToNativeMessageId);

    if (!passive) {
      const allowed = kind === 'private' ? this.allowProactivePrivate : this.allowProactiveGroup;
      if (!allowed) {
        throw new BridgeError({
          code: 'capability_unsupported',
          message: `proactive_messages_disabled:${kind}`,
          retryable: false,
        });
      }
    }

    const prepared = prepareSegments(message.segments);
    if (prepared.content.length === 0 && prepared.attachments.length === 0) {
      throw new BridgeError({
        code: 'invalid_config',
        message: 'qq_empty_message',
        retryable: false,
      });
    }

    let msgSeq = 1;
    let lastId = '';

    for (const chunk of splitContent(prepared.content)) {
      const result = await this.rest.sendMessage({
        conversationKind: kind,
        openId: target.conversationNativeId,
        content: chunk,
        ...(target.replyToNativeMessageId
          ? { replyToMessageId: target.replyToNativeMessageId, msgSeq }
          : {}),
      });
      msgSeq += 1;
      lastId = result.id;
    }

    for (const attachment of prepared.attachments) {
      const downloaded = await this.download(attachment);
      const upload = await this.rest.uploadMedia({
        conversationKind: kind,
        openId: target.conversationNativeId,
        data: downloaded.data,
        filename: attachment.filename,
        contentType: downloaded.contentType,
        fileType: attachment.isImage ? QQ_FILE_TYPE.IMAGE : QQ_FILE_TYPE.FILE,
      });
      const result = await this.rest.sendMessage({
        conversationKind: kind,
        openId: target.conversationNativeId,
        mediaFileInfo: upload.fileInfo,
        ...(target.replyToNativeMessageId
          ? { replyToMessageId: target.replyToNativeMessageId, msgSeq }
          : {}),
      });
      msgSeq += 1;
      lastId = result.id;
    }

    return { nativeMessageId: lastId };
  }

  private async download(
    attachment: PreparedAttachment,
  ): Promise<{ data: Uint8Array; contentType: string }> {
    let response: Response;
    try {
      response = await (this.fetchImpl ?? fetch)(attachment.url, {
        signal: AbortSignal.timeout(this.mediaTimeoutMs),
      });
    } catch (error) {
      throw new BridgeError({
        code: 'attachment_unavailable',
        message: 'qq_media_download_failed',
        retryable: false,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new BridgeError({
        code: 'attachment_unavailable',
        message: `qq_media_download_http_${response.status}`,
        retryable: false,
      });
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > this.mediaMaxBytes) {
      throw new BridgeError({
        code: 'message_too_large',
        message: `qq_media_too_large: ${data.byteLength}`,
        retryable: false,
      });
    }
    return {
      data,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

function mapAttachments(attachments: readonly QqAttachment[] | undefined):
  | Array<{
      url: string;
      filename?: string | null;
      contentType?: string | null;
      size?: number | null;
      width?: number | null;
      height?: number | null;
      urlExpiresAt?: string | null;
    }>
  | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    url: attachment.url,
    filename: attachment.filename ?? null,
    contentType: attachment.content_type ?? null,
    size: attachment.size ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    urlExpiresAt: attachment.url_expires_at ?? attachment.url_expire_at ?? null,
  }));
}

interface PreparedContent {
  content: string;
  attachments: PreparedAttachment[];
}

function prepareSegments(segments: readonly UnifiedSegment[]): PreparedContent {
  let content = '';
  const attachments: PreparedAttachment[] = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        content += segment.text;
        break;
      case 'mention':
        // QQ official bots cannot render outbound @-mentions in plain text.
        break;
      case 'image':
        attachments.push({
          url: segment.url,
          filename: segment.filename ?? 'image.png',
          isImage: true,
        });
        break;
      case 'file':
        attachments.push({ url: segment.url, filename: segment.filename, isImage: false });
        break;
      default:
        break;
    }
  }
  return { content, attachments };
}

function splitContent(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  if (content.length <= QQ_MAX_CONTENT_LENGTH) {
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
