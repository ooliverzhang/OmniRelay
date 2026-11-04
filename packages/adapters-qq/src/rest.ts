import { BridgeError } from '@omni-relay/shared-types';

import { mapQqHttpError, parseRetryAfterMs, qqNetworkError } from './errors.js';
import type { QqTokenManager } from './token.js';
import { QQ_FILE_TYPE, QQ_MESSAGE_TYPE } from './types.js';

export interface QqRestOptions {
  appId: string;
  tokenManager: QqTokenManager;
  apiBaseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch | undefined;
  userAgent?: string | undefined;
}

export interface QqSendMessageInput {
  conversationKind: 'private' | 'group';
  /** `user_openid` for private chats, `group_openid` for groups. */
  openId: string;
  content?: string;
  /** `file_info` returned by {@link QqRestClient.uploadMedia}. */
  mediaFileInfo?: string;
  msgType?: number;
  /** Inbound `msg_id`; presence makes this a passive reply. */
  replyToMessageId?: string;
  /** Passive reply sequence number (1..5). */
  msgSeq?: number;
}

export interface QqSendResult {
  id: string;
  timestamp?: string;
}

export interface QqUploadInput {
  conversationKind: 'private' | 'group';
  openId: string;
  data: Uint8Array;
  filename: string;
  contentType: string;
  /** 1 image, 2 video, 3 audio, 4 file. */
  fileType?: number;
}

export interface QqUploadResult {
  fileInfo: string;
  ttlSeconds?: number;
}

/**
 * QQ official bot REST client.
 *
 * Sending requires an access token; a 401 triggers exactly one token refresh
 * before the error is surfaced.
 */
export class QqRestClient {
  private readonly appId: string;
  private readonly tokenManager: QqTokenManager;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: QqRestOptions) {
    this.appId = options.appId;
    this.tokenManager = options.tokenManager;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'OmniRelay/0.1.0';
  }

  async getGatewayUrl(): Promise<string> {
    const data = await this.request<{ url?: unknown }>('GET', '/gateway');
    const url = typeof data.url === 'string' ? data.url : null;
    if (!url) {
      throw new BridgeError({
        code: 'platform_unavailable',
        message: 'qq_gateway_url_missing',
        retryable: true,
      });
    }
    return url;
  }

  async sendMessage(input: QqSendMessageInput): Promise<QqSendResult> {
    const path =
      input.conversationKind === 'group'
        ? `/v2/groups/${encodeURIComponent(input.openId)}/messages`
        : `/v2/users/${encodeURIComponent(input.openId)}/messages`;

    const body: Record<string, unknown> = {
      msg_type: input.msgType ?? (input.mediaFileInfo ? QQ_MESSAGE_TYPE.MEDIA : QQ_MESSAGE_TYPE.TEXT),
    };
    if (input.content !== undefined && input.content.length > 0) {
      body['content'] = input.content;
    }
    if (input.mediaFileInfo) {
      body['media'] = { file_info: input.mediaFileInfo };
    }
    if (input.replyToMessageId) {
      body['msg_id'] = input.replyToMessageId;
      body['msg_seq'] = input.msgSeq ?? 1;
    }

    const data = await this.request<{ id?: unknown; timestamp?: unknown }>('POST', path, body);
    const id = typeof data.id === 'string' ? data.id : null;
    if (!id) {
      throw new BridgeError({
        code: 'platform_unavailable',
        message: 'qq_send_missing_message_id',
        retryable: true,
      });
    }
    return {
      id,
      ...(typeof data.timestamp === 'string' ? { timestamp: data.timestamp } : {}),
    };
  }

  async uploadMedia(input: QqUploadInput): Promise<QqUploadResult> {
    const path =
      input.conversationKind === 'group'
        ? `/v2/groups/${encodeURIComponent(input.openId)}/files`
        : `/v2/users/${encodeURIComponent(input.openId)}/files`;

    const form = new FormData();
    form.append('file_type', String(input.fileType ?? QQ_FILE_TYPE.FILE));
    form.append('srv_send_msg', 'false');
    form.append(
      'file_data',
      new Blob([input.data], { type: input.contentType }),
      input.filename,
    );

    const data = await this.request<{ file_info?: unknown; ttl?: unknown }>('POST', path, form, true);
    const fileInfo = typeof data.file_info === 'string' ? data.file_info : null;
    if (!fileInfo) {
      throw new BridgeError({
        code: 'platform_rejected',
        message: 'qq_upload_missing_file_info',
        retryable: false,
      });
    }
    const ttl = Number(data.ttl);
    return {
      fileInfo,
      ...(Number.isFinite(ttl) && ttl > 0 ? { ttlSeconds: ttl } : {}),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown> | FormData,
    isUpload = false,
  ): Promise<T> {
    const attempt = async (forceRefresh: boolean): Promise<T> => {
      const token = await this.tokenManager.getAccessToken(forceRefresh);
      const headers: Record<string, string> = {
        Authorization: `QQBot ${token}`,
        'X-Union-Appid': this.appId,
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      };

      let payload: string | FormData | undefined;
      if (body instanceof FormData) {
        payload = body;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw qqNetworkError(error);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const text = await response.text();
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        throw mapQqHttpError(response.status, text, retryAfterMs);
      }

      if (text.length === 0) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new BridgeError({
          code: 'platform_unavailable',
          message: `qq_invalid_json_response${isUpload ? '_upload' : ''}`,
          retryable: true,
          cause: error,
        });
      }
    };

    try {
      return await attempt(false);
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'unauthorized') {
        this.tokenManager.invalidate();
        return attempt(true);
      }
      throw error;
    }
  }
}
