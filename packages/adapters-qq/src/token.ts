import { BridgeError } from '@omni-relay/shared-types';

import { mapQqHttpError, parseRetryAfterMs, qqNetworkError } from './errors.js';

export interface QqTokenLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface QqTokenManagerOptions {
  appId: string;
  /** Resolved from the environment by the caller; never defaulted in code. */
  appSecret: string;
  tokenUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  logger?: QqTokenLogger | undefined;
  /** Refresh the token this many seconds before it actually expires. */
  refreshMarginSeconds?: number | undefined;
}

export interface QqAccessToken {
  token: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
}

/**
 * QQ access-token cache.
 *
 * The token is fetched with AppID + AppSecret and refreshed slightly before it
 * expires; neither the secret nor the token is ever logged.
 */
export class QqTokenManager {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly logger: QqTokenLogger | undefined;
  private readonly refreshMarginSeconds: number;
  private cached: QqAccessToken | null = null;
  private inflight: Promise<QqAccessToken> | null = null;

  constructor(options: QqTokenManagerOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.tokenUrl = options.tokenUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    this.refreshMarginSeconds = options.refreshMarginSeconds ?? 60;
  }

  getCached(): QqAccessToken | null {
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && this.isUsable(this.cached)) {
      return this.cached.token;
    }
    const refreshed = await this.refresh();
    return refreshed.token;
  }

  async refresh(): Promise<QqAccessToken> {
    if (this.inflight) {
      return this.inflight;
    }
    const promise = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    this.inflight = promise;
    return promise;
  }

  private isUsable(token: QqAccessToken): boolean {
    const expiresAt = Date.parse(token.expiresAt);
    if (Number.isNaN(expiresAt)) {
      return false;
    }
    return expiresAt - this.refreshMarginSeconds * 1000 > this.now().getTime();
  }

  private async fetchToken(): Promise<QqAccessToken> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw qqNetworkError(error);
    }

    const text = await response.text();
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      throw mapQqHttpError(response.status, text, retryAfterMs);
    }

    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
    } catch (error) {
      throw new BridgeError({
        code: 'platform_unavailable',
        message: 'qq_token_invalid_json',
        retryable: true,
        cause: error,
      });
    }

    const token = typeof parsed.access_token === 'string' ? parsed.access_token : null;
    if (!token) {
      throw new BridgeError({
        code: 'unauthorized',
        message: 'qq_token_missing_in_response',
        retryable: false,
      });
    }

    const expiresIn = Number(parsed.expires_in);
    const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7_200;
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();

    this.cached = { token, expiresAt };
    this.logger?.debug('qq access token refreshed', { expiresAt, ttlSeconds });
    return this.cached;
  }
}
