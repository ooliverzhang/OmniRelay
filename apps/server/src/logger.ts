import { pino, type Logger as PinoLogger } from 'pino';

import type { AppConfig } from '@omni-relay/shared-types';
import type { Storage } from '@omni-relay/storage';

export interface LogMeta {
  [key: string]: unknown;
}

export interface AppLogger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** Structured child logger that always carries the given bindings. */
  child(bindings: LogMeta): AppLogger;
}

const REDACTED = '[redacted]';
const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|token|access_token|appsecret|app_secret|secret|password|passwd|api[-_]?key)$/i;
const SENSITIVE_INLINE = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/g,
  /((?:access_token|token|app_secret|appsecret|secret|clientSecret|password)=)[^&\s"']+/gi,
  /\b[MN][\w-]{23,}\.[\w-]{6}\.[\w-]{27,}\b/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
];

/** Masks credentials in free-form text (log lines, error messages). */
export function redactText(value: string): string {
  let output = value;
  output = output.replace(SENSITIVE_INLINE[0] as RegExp, `$1${REDACTED}`);
  output = output.replace(SENSITIVE_INLINE[1] as RegExp, `$1${REDACTED}`);
  output = output.replace(SENSITIVE_INLINE[2] as RegExp, REDACTED);
  output = output.replace(SENSITIVE_INLINE[3] as RegExp, REDACTED);
  return output;
}

/** Deep redaction for structured metadata before it reaches stdout or SQLite. */
export function redactMeta(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[truncated]';
  }
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactMeta(entry, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactMeta(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export interface CreateLoggerOptions {
  config: Pick<AppConfig, 'logging'>;
  storage?: Storage | undefined;
  /** Persist a copy of every record to the console log table. */
  persistToStorage?: boolean | undefined;
  prettyOverride?: boolean | undefined;
}

const LEVEL_WEIGHT: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Application logger: pino JSON on stdout plus an optional SQLite sink that
 * powers the `/logs` page of the console. Every message is redacted first.
 */
export function createLogger(options: CreateLoggerOptions): AppLogger {
  const storage = options.persistToStorage === false ? undefined : options.storage;
  const redactPaths: string[] = [
    'req.headers.authorization',
    'req.headers.cookie',
    'headers.authorization',
    'headers.cookie',
    'token',
    'accessToken',
    'appSecret',
    'password',
    'secret',
  ];
  const baseOptions = {
    level: options.config.logging.level,
    redact: { paths: redactPaths, censor: REDACTED },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  const pretty = options.prettyOverride ?? options.config.logging.pretty;
  const root: PinoLogger = pretty
    ? pino({
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      })
    : pino(baseOptions);

  return wrap(root, storage, {});
}

function wrap(pinoLogger: PinoLogger, storage: Storage | undefined, bindings: LogMeta): AppLogger {
  const emit = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: LogMeta): void => {
    const safeMessage = redactText(message);
    const merged = { ...bindings, ...(meta ?? {}) };
    const safeMeta = redactMeta(merged) as Record<string, unknown>;

    try {
      pinoLogger[level](safeMeta, safeMessage);
    } catch {
      // logging must never break the bridge
    }

    if (!storage) {
      return;
    }
    const weight = LEVEL_WEIGHT[level] ?? 30;
    if (weight < (LEVEL_WEIGHT['info'] ?? 30)) {
      return;
    }
    try {
      storage.logs.append({
        level,
        msg: safeMessage,
        time: new Date(),
        platform: typeof safeMeta['platform'] === 'string' ? safeMeta['platform'] : null,
        event: typeof safeMeta['event'] === 'string' ? safeMeta['event'] : null,
        context: safeMeta,
      });
    } catch {
      // the storage may already be closed during shutdown
    }
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child: (extra) => wrap(pinoLogger, storage, { ...bindings, ...extra }),
  };
}
