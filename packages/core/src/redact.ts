/** Placeholder that replaces every sensitive value in redacted output. */
export const REDACTED = '[redacted]';

/** Deep objects deeper than this are replaced entirely instead of walked. */
const MAX_REDACT_DEPTH = 6;

/** `Authorization: Bearer <token>` — keeps the header name, drops the value. */
const AUTHORIZATION_BEARER = /(authorization\s*:\s*bearer)\s+[^\s,;]+/gi;

/** A bare `Bearer <token>` occurrence. */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/** Discord bot token shape: base64 id, timestamp, hmac. */
const DISCORD_BOT_TOKEN = /[MN][\w-]{23,}\.[\w-]{6}\.[\w-]{27,}/g;

/** OpenAI-style API keys. */
const SK_API_KEY = /\bsk-[A-Za-z0-9_-]{4,}/g;

/** `token=...`, `app_secret=...` and friends; the key is preserved. */
const SENSITIVE_ASSIGNMENT =
  /(access_token|refresh_token|app_secret|client_secret|api_key|apikey|token|secret|password|passwd)=([^&\s"'#]+)/gi;

/** Object keys whose values must never be logged. */
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|appsecret|api[-_]?key/i;

/** Redacts credentials embedded in free-form text, keeping key names intact. */
export function redactText(text: string): string {
  return text
    .replace(AUTHORIZATION_BEARER, (_match, key: string) => `${key} ${REDACTED}`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(DISCORD_BOT_TOKEN, REDACTED)
    .replace(SK_API_KEY, REDACTED)
    .replace(SENSITIVE_ASSIGNMENT, (_match, key: string) => `${key}=${REDACTED}`);
}

/** Recursively redacts a value; sensitive keys are replaced regardless of shape. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (depth > MAX_REDACT_DEPTH) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, depth + 1);
  }
  return output;
}

/** Redacts a flat-ish record such as request headers or a config snapshot. */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactValue(record, 0);
  if (redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return {};
}

/** Masks a secret for display: 4 leading and 4 trailing characters when long. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return REDACTED;
  }
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
