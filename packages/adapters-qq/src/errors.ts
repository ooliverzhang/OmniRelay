import { BridgeError, type ErrorCode } from '@omni-relay/shared-types';

/**
 * QQ official bot failures are reported both as HTTP statuses and as business
 * codes inside the JSON body. Both are classified here so that permanent quota
 * or permission errors are never retried in a loop.
 */
export interface QqErrorBody {
  code?: number;
  message?: string;
  err_code?: number;
  msg?: string;
}

const RATE_LIMIT_CODES = new Set([304023, 304024, 304027, 11253, 22009]);
const QUOTA_CODES = new Set([304030, 304031, 304032, 304033]);
const AUTH_CODES = new Set([11241, 11242, 11243, 12101, 12102]);
const NOT_FOUND_CODES = new Set([304002, 304003, 304004]);

export function mapQqHttpError(status: number, body: string, retryAfterMs?: number): BridgeError {
  const parsed = safeParse(body);
  const businessCode = parsed?.code ?? parsed?.err_code ?? null;
  const detail = (parsed?.message ?? parsed?.msg ?? '').slice(0, 200);
  const code = classify(status, businessCode, detail);
  const retryable =
    code === 'rate_limited' || code === 'platform_unavailable' || code === 'internal';

  return new BridgeError({
    code,
    message: describe(code, status, businessCode, detail),
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    details: { status, businessCode },
  });
}

function classify(status: number, businessCode: number | null, detail: string): ErrorCode {
  const lowered = detail.toLowerCase();
  if (businessCode !== null) {
    if (RATE_LIMIT_CODES.has(businessCode)) {
      return 'rate_limited';
    }
    if (QUOTA_CODES.has(businessCode)) {
      return 'quota_exceeded';
    }
    if (AUTH_CODES.has(businessCode)) {
      return 'unauthorized';
    }
    if (NOT_FOUND_CODES.has(businessCode)) {
      return 'not_found';
    }
  }
  if (
    lowered.includes('频率') ||
    lowered.includes('too many') ||
    lowered.includes('rate limit') ||
    lowered.includes('频繁')
  ) {
    return 'rate_limited';
  }
  if (
    lowered.includes('额度') ||
    lowered.includes('quota') ||
    lowered.includes('主动消息') ||
    lowered.includes('proactive')
  ) {
    return 'quota_exceeded';
  }
  if (lowered.includes('权限') || lowered.includes('permission') || lowered.includes('forbidden')) {
    return 'forbidden';
  }
  if (lowered.includes('审核') || lowered.includes('audit') || lowered.includes('sensitive')) {
    return 'platform_rejected';
  }
  if (lowered.includes('过期') || lowered.includes('expired') || lowered.includes('msg_id')) {
    return 'platform_rejected';
  }
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
    return 'platform_rejected';
  }
  return 'platform_rejected';
}

function describe(
  code: ErrorCode,
  status: number,
  businessCode: number | null,
  detail: string,
): string {
  const suffix = businessCode === null ? '' : ` (${businessCode})`;
  const text = detail.length > 0 ? `: ${detail}` : '';
  return `qq_${code}${suffix} [http ${status}]${text}`.slice(0, 300);
}

function safeParse(body: string): QqErrorBody | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as QqErrorBody;
    }
  } catch {
    // not json
  }
  return null;
}

export function qqNetworkError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const isAbort = message.toLowerCase().includes('abort') || message.includes('timeout');
  return new BridgeError({
    code: isAbort ? 'timeout' : 'platform_unavailable',
    message: `qq_network_error: ${message.slice(0, 200)}`,
    retryable: true,
    cause: error,
  });
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
