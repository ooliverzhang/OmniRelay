import { BridgeError, type ErrorCode } from '@omni-relay/shared-types';

/**
 * Maps Discord REST/Gateway failures onto the bridge error vocabulary so that
 * the queue can decide between retry, dead-letter and hard failure.
 */
export function mapDiscordHttpStatus(
  status: number,
  body: string,
  retryAfterMs?: number,
): BridgeError {
  const code = classify(status, body);
  const detail = extractDiscordMessage(body);
  return new BridgeError({
    code,
    message: `discord_http_${status}${detail ? `: ${detail}` : ''}`,
    retryable: code === 'rate_limited' || code === 'platform_unavailable' || code === 'internal',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    details: { status },
  });
}

function classify(status: number, body: string): ErrorCode {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 413) {
    return 'message_too_large';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 500) {
    return 'platform_unavailable';
  }
  if (status === 400) {
    const lowered = body.toLowerCase();
    if (lowered.includes('maximum') || lowered.includes('too long')) {
      return 'message_too_large';
    }
    if (lowered.includes('cannot send messages') || lowered.includes('missing permissions')) {
      return 'forbidden';
    }
    if (lowered.includes('unknown channel') || lowered.includes('unknown user')) {
      return 'not_found';
    }
    return 'platform_rejected';
  }
  return 'platform_rejected';
}

function extractDiscordMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === 'string') {
      return parsed.message.slice(0, 200);
    }
    if (typeof parsed.error === 'string') {
      return parsed.error.slice(0, 200);
    }
  } catch {
    // not json
  }
  return body.trim().length > 0 ? body.trim().slice(0, 200) : null;
}

export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  return undefined;
}

export function networkError(error: unknown): BridgeError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BridgeError) {
    return error;
  }
  const isAbort = message.includes('abort') || message.includes('timeout');
  return new BridgeError({
    code: isAbort ? 'timeout' : 'platform_unavailable',
    message: `discord_network_error: ${message.slice(0, 200)}`,
    retryable: true,
    cause: error,
  });
}
