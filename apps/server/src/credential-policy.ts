import type { Platform } from '@omni-relay/shared-types';

/**
 * Credential keys that the console is allowed to write, per platform.
 *
 * This is an allowlist on purpose: an authenticated console user must never be
 * able to inject arbitrary keys into `.env` (that would allow e.g. overriding
 * `NODE_OPTIONS` or `PATH` and escaping the intended trust boundary).
 */
export const CREDENTIAL_ENV_ALLOWLIST: Record<Platform | 'onebot', readonly string[]> = {
  discord: ['DISCORD_BOT_TOKEN'],
  'qq-official': ['QQ_APP_ID', 'QQ_APP_SECRET'],
  onebot: ['ONEBOT_BRIDGE_TOKEN'],
};

export const CREDENTIAL_MAX_LENGTH = 512;

export type CredentialTarget = Platform | 'onebot';

export function isCredentialTarget(value: string): value is CredentialTarget {
  return value === 'discord' || value === 'qq-official' || value === 'onebot';
}

export function isAllowedCredentialKey(target: CredentialTarget, key: string): boolean {
  return CREDENTIAL_ENV_ALLOWLIST[target].includes(key);
}

export interface CredentialValidationResult {
  ok: boolean;
  /** Machine readable reason, e.g. `empty_value`. */
  reason: string | null;
  /** Trimmed value, only present when `ok`. */
  value: string | null;
}

/**
 * Validates a credential value before it is written to `.env`.
 *
 * Values are trimmed, must be non-empty, must not contain control characters
 * (which could be used to smuggle extra `.env` lines) and are capped at
 * {@link CREDENTIAL_MAX_LENGTH}.
 */
export function validateCredentialValue(raw: unknown): CredentialValidationResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'not_a_string', value: null };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, reason: 'empty_value', value: null };
  }
  if (value.length > CREDENTIAL_MAX_LENGTH) {
    return { ok: false, reason: 'value_too_long', value: null };
  }
  // Newlines / carriage returns would terminate the KEY="..." line early and
  // let the caller inject arbitrary additional keys into the file.
  if (/[\r\n\u0000]/.test(value)) {
    return { ok: false, reason: 'value_has_control_characters', value: null };
  }
  return { ok: true, reason: null, value };
}
