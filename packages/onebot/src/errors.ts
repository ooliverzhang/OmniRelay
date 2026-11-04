import { isBridgeError, ONEBOT_RETCODE } from '@omni-relay/shared-types';
import type { ErrorCode, OneBotActionResponse } from '@omni-relay/shared-types';

/**
 * Translation of internal `BridgeError`s into OneBot 11 action responses.
 *
 * Error messages are redacted and truncated before they leave the process so a
 * handler failure can never echo a credential back to the client.
 */

/** Maximum length of a response message, in characters. */
const MAX_MESSAGE_LENGTH = 512;

const REDACTED = '[redacted]';

/**
 * Applied in order; `access_token=` is handled before the generic `token=`
 * pattern so that query-style credentials are redacted as a whole.
 */
const REDACTION_PATTERNS: readonly RegExp[] = [
  /access_token=\S+/gi,
  /secret=\S+/gi,
  /token=\S+/gi,
  /bearer\s+\S+/gi,
];

const RETCODE_BY_ERROR_CODE: Record<ErrorCode, number> = {
  invalid_config: ONEBOT_RETCODE.BAD_REQUEST,
  unauthorized: ONEBOT_RETCODE.UNAUTHORIZED,
  forbidden: ONEBOT_RETCODE.UNAUTHORIZED,
  not_found: ONEBOT_RETCODE.NOT_FOUND,
  capability_unsupported: ONEBOT_RETCODE.CAPABILITY_UNSUPPORTED,
  rate_limited: ONEBOT_RETCODE.RATE_LIMITED,
  timeout: ONEBOT_RETCODE.TIMEOUT,
  message_too_large: ONEBOT_RETCODE.BAD_REQUEST,
  platform_rejected: ONEBOT_RETCODE.PLATFORM_REJECTED,
  quota_exceeded: ONEBOT_RETCODE.PLATFORM_REJECTED,
  attachment_unavailable: ONEBOT_RETCODE.PLATFORM_REJECTED,
  platform_unavailable: ONEBOT_RETCODE.INTERNAL_ERROR,
  internal: ONEBOT_RETCODE.INTERNAL_ERROR,
};

/** Removes common credential shapes and clamps the result to 512 characters. */
export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;
  for (const pattern of REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTED);
  }
  return sanitized.length > MAX_MESSAGE_LENGTH ? sanitized.slice(0, MAX_MESSAGE_LENGTH) : sanitized;
}

/**
 * Builds a `failed` action response for any thrown value.
 *
 * Non `BridgeError` values are mapped to `1500` with a fixed message so that
 * internal details (message, stack, cause) never reach the client.
 */
export function toOneBotErrorResponse(
  error: unknown,
  echo?: string | number,
): OneBotActionResponse {
  let retcode: number;
  let message: string;

  if (isBridgeError(error)) {
    retcode = RETCODE_BY_ERROR_CODE[error.code];
    const raw =
      typeof error.message === 'string' && error.message.length > 0 ? error.message : error.code;
    message = sanitizeErrorMessage(raw);
  } else {
    retcode = ONEBOT_RETCODE.INTERNAL_ERROR;
    message = 'internal_error';
  }

  const response: OneBotActionResponse = { status: 'failed', retcode, message };
  if (echo !== undefined) {
    response.echo = echo;
  }
  return response;
}
