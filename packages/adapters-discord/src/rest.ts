import { BridgeError } from '@omni-relay/shared-types';

import { mapDiscordHttpStatus, networkError, parseRetryAfterMs } from './errors.js';
import type {
  DiscordChannel,
  DiscordMessage,
  DiscordMessageReference,
  DiscordUser,
} from './types.js';

export interface DiscordFileUpload {
  filename: string;
  data: Uint8Array;
  contentType: string;
}

export interface DiscordCreateMessageBody {
  content?: string;
  message_reference?: DiscordMessageReference;
  allowed_mentions?: { parse?: string[]; replied_user?: boolean };
  files?: DiscordFileUpload[];
}

export interface DiscordSendResult {
  id: string;
  channel_id: string;
}

export interface DiscordRestOptions {
  token: string;
  apiBaseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const DISCORD_MAX_CONTENT = 2000;

/**
 * Minimal Discord REST client.
 *
 * Only the endpoints OmniRelay needs are implemented; every failure is mapped
 * onto {@link BridgeError} so the outbox worker can classify it.
 */
export class DiscordRestClient {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: DiscordRestOptions) {
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'OmniRelay (https://github.com/omni-relay, 0.1.0)';
  }

  async getCurrentUser(): Promise<DiscordUser> {
    return this.request<DiscordUser>('GET', '/users/@me');
  }

  async getChannel(channelId: string): Promise<DiscordChannel> {
    return this.request<DiscordChannel>('GET', `/channels/${encodeURIComponent(channelId)}`);
  }

  async getGuild(guildId: string): Promise<{ id: string; name: string }> {
    return this.request<{ id: string; name: string }>(
      'GET',
      `/guilds/${encodeURIComponent(guildId)}`,
    );
  }

  async listGuildChannels(guildId: string): Promise<DiscordChannel[]> {
    return this.request<DiscordChannel[]>('GET', `/guilds/${encodeURIComponent(guildId)}/channels`);
  }

  async openDirectMessage(userId: string): Promise<DiscordChannel> {
    return this.request<DiscordChannel>('POST', '/users/@me/channels', {
      recipient_id: userId,
    });
  }

  async createMessage(
    channelId: string,
    body: DiscordCreateMessageBody,
  ): Promise<DiscordSendResult> {
    const path = `/channels/${encodeURIComponent(channelId)}/messages`;
    const content = body.content ?? '';
    if (content.length > DISCORD_MAX_CONTENT) {
      throw new BridgeError({
        code: 'message_too_large',
        message: `discord_content_too_long: ${content.length}`,
        retryable: false,
      });
    }

    const json: Record<string, unknown> = {};
    if (content.length > 0) {
      json['content'] = content;
    }
    if (body.message_reference) {
      json['message_reference'] = body.message_reference;
    }
    if (body.allowed_mentions) {
      json['allowed_mentions'] = body.allowed_mentions;
    }

    if (body.files && body.files.length > 0) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(json));
      body.files.forEach((file, index) => {
        form.append(
          `files[${index}]`,
          new Blob([file.data], { type: file.contentType }),
          file.filename,
        );
      });
      return this.request<DiscordSendResult>('POST', path, form);
    }

    return this.request<DiscordSendResult>('POST', path, json);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  async getMessage(channelId: string, messageId: string): Promise<DiscordMessage> {
    return this.request<DiscordMessage>(
      'GET',
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    jsonBody?: Record<string, unknown> | FormData,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
      'User-Agent': this.userAgent,
      Accept: 'application/json',
    };

    let body: string | FormData | undefined;
    if (jsonBody instanceof FormData) {
      body = jsonBody;
    } else if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(jsonBody);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw networkError(error);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw mapDiscordHttpStatus(response.status, text, retryAfterMs);
    }

    if (text.length === 0) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new BridgeError({
        code: 'platform_unavailable',
        message: 'discord_invalid_json_response',
        retryable: true,
        cause: error,
      });
    }
  }
}
