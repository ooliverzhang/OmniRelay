import { isBridgeError, type FailureInfo } from '@omni-relay/shared-types';

import type { ClassifiedFailure } from './contracts.js';

const MAX_MESSAGE_LENGTH = 500;

/**
 * Redacts the credentials that platform SDK errors love to echo back.
 * The queue never logs raw payloads, but error strings are forwarded to the
 * dead-letter table and the console, so they must be scrubbed first.
 */
export function redactText(value: string): string {
  let text = value.replace(/[\r\n]+/g, ' ').trim();
  text = text.replace(/Bearer\s+\S+/gi, '[redacted]');
  text = text.replace(/token=\S+/gi, '[redacted]');
  text = text.replace(/secret=\S+/gi, '[redacted]');
  if (text.length > MAX_MESSAGE_LENGTH) {
    text = `${text.slice(0, MAX_MESSAGE_LENGTH)}…`;
  }
  return text;
}

function describeUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return String(value);
  } catch {
    return 'unknown error';
  }
}

/**
 * Maps anything a sender may throw onto a {@link FailureInfo}.
 *
 * - `BridgeError` keeps its code and derived retryability.
 * - Plain `Error`s are treated as transient (network/SDK failures).
 * - Anything else is a permanent internal error.
 * The message never contains a stack trace and is always redacted.
 */
export function classifyDeliveryError(error: unknown): ClassifiedFailure {
  if (isBridgeError(error)) {
    const failure: FailureInfo = {
      kind: error.retryable ? 'retryable' : 'permanent',
      code: error.code,
      message: redactText(error.message),
    };
    if (typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)) {
      failure.retryAfterMs = Math.max(0, Math.floor(error.retryAfterMs));
    }
    return { failure, permanent: !error.retryable };
  }

  if (error instanceof Error) {
    return {
      failure: { kind: 'retryable', code: 'unknown_error', message: redactText(error.message) },
      permanent: false,
    };
  }

  return {
    failure: { kind: 'permanent', code: 'internal', message: redactText(describeUnknown(error)) },
    permanent: true,
  };
}
