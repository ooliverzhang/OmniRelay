import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_ENV_ALLOWLIST,
  CREDENTIAL_MAX_LENGTH,
  isAllowedCredentialKey,
  isCredentialTarget,
  validateCredentialValue,
} from '../../apps/server/src/credential-policy.js';
import { parseEnvKey } from '../../apps/server/src/routes/credentials.js';

describe('credential allowlist', () => {
  it('only exposes the documented keys per platform', () => {
    expect(CREDENTIAL_ENV_ALLOWLIST.discord).toEqual(['DISCORD_BOT_TOKEN']);
    expect(CREDENTIAL_ENV_ALLOWLIST['qq-official']).toEqual(['QQ_APP_ID', 'QQ_APP_SECRET']);
    expect(CREDENTIAL_ENV_ALLOWLIST.onebot).toEqual(['ONEBOT_BRIDGE_TOKEN']);
  });

  it('rejects keys that could hijack the process environment', () => {
    for (const key of ['NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'DISCORD_BOT_TOKEN ']) {
      expect(isAllowedCredentialKey('discord', key)).toBe(false);
    }
    expect(isAllowedCredentialKey('discord', 'DISCORD_BOT_TOKEN')).toBe(true);
    expect(isAllowedCredentialKey('qq-official', 'QQ_APP_SECRET')).toBe(true);
    expect(isAllowedCredentialKey('qq-official', 'DISCORD_BOT_TOKEN')).toBe(false);
  });

  it('recognises the supported targets only', () => {
    expect(isCredentialTarget('discord')).toBe(true);
    expect(isCredentialTarget('qq-official')).toBe(true);
    expect(isCredentialTarget('onebot')).toBe(true);
    expect(isCredentialTarget('telegram')).toBe(false);
    expect(isCredentialTarget('')).toBe(false);
  });
});

describe('validateCredentialValue', () => {
  it('trims surrounding whitespace but preserves inner characters', () => {
    const result = validateCredentialValue('  test-token-value  ');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('test-token-value');
  });

  it('rejects empty and whitespace-only values', () => {
    expect(validateCredentialValue('').ok).toBe(false);
    expect(validateCredentialValue('   ').ok).toBe(false);
    expect(validateCredentialValue('').reason).toBe('empty_value');
  });

  it('rejects non-string values', () => {
    expect(validateCredentialValue(123).reason).toBe('not_a_string');
    expect(validateCredentialValue(null).reason).toBe('not_a_string');
    expect(validateCredentialValue({}).reason).toBe('not_a_string');
  });

  it('enforces the length ceiling', () => {
    expect(validateCredentialValue('x'.repeat(CREDENTIAL_MAX_LENGTH)).ok).toBe(true);
    expect(validateCredentialValue('x'.repeat(CREDENTIAL_MAX_LENGTH + 1)).reason).toBe(
      'value_too_long',
    );
  });

  it('rejects newlines that would inject extra env keys', () => {
    expect(validateCredentialValue('abc\nEVIL=1').reason).toBe('value_has_control_characters');
    expect(validateCredentialValue('abc\r\nEVIL=1').reason).toBe('value_has_control_characters');
    expect(validateCredentialValue('abc\u0000def').reason).toBe('value_has_control_characters');
  });
});

describe('parseEnvKey', () => {
  it('accepts plain env identifiers', () => {
    expect(parseEnvKey('DISCORD_BOT_TOKEN')).toBe('DISCORD_BOT_TOKEN');
    expect(parseEnvKey(' QQ_APP_ID ')).toBe('QQ_APP_ID');
    expect(parseEnvKey('A1_B2')).toBe('A1_B2');
  });

  it('rejects path traversal, dots, dashes and lowercase', () => {
    for (const raw of ['../etc/passwd', 'a.b', 'a-b', 'foo', '1ABC', '', 'A B', 'A'.repeat(200)]) {
      expect(parseEnvKey(raw)).toBeNull();
    }
  });
});
