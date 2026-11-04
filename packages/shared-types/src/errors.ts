/**
 * Typed bridge errors. Adapters and queue workers classify native platform
 * failures into these codes so the retry policy can decide what is retryable.
 */
export const ERROR_CODES = [
  'invalid_config',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'platform_unavailable',
  'capability_unsupported',
  'platform_rejected',
  'quota_exceeded',
  'message_too_large',
  'attachment_unavailable',
  'timeout',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Retryable: transient connectivity, throttling and temporary upstream faults.
 * Everything else is a permanent failure and goes straight to the dead-letter
 * table instead of burning attempts.
 */
export const RETRYABLE_ERROR_CODES = [
  'rate_limited',
  'platform_unavailable',
  'timeout',
  'internal',
] as const satisfies readonly ErrorCode[];

export function isRetryableCode(code: ErrorCode): boolean {
  return (RETRYABLE_ERROR_CODES as readonly ErrorCode[]).includes(code);
}

export interface BridgeErrorOptions {
  code: ErrorCode;
  message: string;
  retryAfterMs?: number;
  cause?: unknown;
  details?: Record<string, unknown>;
  /** Override the classification derived from the code. */
  retryable?: boolean;
}

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: BridgeErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeError';
    this.code = options.code;
    this.retryable = options.retryable ?? isRetryableCode(options.code);
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError;
}

export function toBridgeError(value: unknown, fallbackCode: ErrorCode = 'internal'): BridgeError {
  if (value instanceof BridgeError) {
    return value;
  }
  if (value instanceof Error) {
    return new BridgeError({ code: fallbackCode, message: value.message, cause: value });
  }
  return new BridgeError({ code: fallbackCode, message: String(value) });
}

/** Short, serialisable description used in the outbox and the console. */
export interface SerializedFailure {
  kind: 'retryable' | 'permanent';
  code: string;
  message: string;
  retryAfterMs?: number;
}

export function serializeFailure(error: unknown): SerializedFailure {
  const bridgeError = toBridgeError(error);
  const failure: SerializedFailure = {
    kind: bridgeError.retryable ? 'retryable' : 'permanent',
    code: bridgeError.code,
    message: bridgeError.message,
  };
  if (bridgeError.retryAfterMs !== undefined) {
    failure.retryAfterMs = bridgeError.retryAfterMs;
  }
  return failure;
}
