import { describe, expect, it } from 'vitest';

import { REDACTED, maskSecret, redactRecord, redactText, redactValue } from '@omni-relay/core';

// Obviously fake token-shaped string: only its shape matters, the redactor must
// match the Discord token pattern without any real credential ever existing.
const DISCORD_TOKEN = 'MFAKEfakefakefakefakefake.AAAAAA.fakefakefakefakefakefakefakefakefake';

describe('redactText', () => {
  it('redacts an Authorization bearer header but keeps the header name', () => {
    const redacted = redactText(`Authorization: Bearer ${DISCORD_TOKEN}`);
    expect(redacted).toContain('Authorization');
    expect(redacted).toContain(REDACTED);
    expect(redacted).not.toContain(DISCORD_TOKEN);
  });

  it('redacts a bare bearer token', () => {
    const redacted = redactText('Bearer abc.def-ghi');
    expect(redacted).toBe(`Bearer ${REDACTED}`);
  });

  it('redacts query style token parameters', () => {
    expect(redactText('access_token=abc123&page=2')).toBe(`access_token=${REDACTED}&page=2`);
    expect(redactText('token=abc123')).toBe(`token=${REDACTED}`);
    expect(redactText('app_secret=shhh')).toBe(`app_secret=${REDACTED}`);
    expect(redactText('secret=shhh')).toBe(`secret=${REDACTED}`);
  });

  it('redacts discord bot token shapes', () => {
    const redacted = redactText(`bot token ${DISCORD_TOKEN} leaked`);
    expect(redacted).not.toContain(DISCORD_TOKEN);
    expect(redacted).toContain(REDACTED);
  });

  it('redacts sk- api keys', () => {
    const redacted = redactText('key sk-abc123def456');
    expect(redacted).not.toContain('sk-abc123def456');
    expect(redacted).toContain(REDACTED);
  });

  it('leaves ordinary text untouched', () => {
    const text = 'hello world, tokenization is fine; the mechanism is documented';
    expect(redactText(text)).toBe(text);
  });
});

describe('redactValue', () => {
  it('redacts sensitive keys at any nesting level', () => {
    const redacted = redactValue({
      authorization: 'Bearer abc',
      nested: { password: 'p', ok: 1 },
      list: [{ apiKey: 'k' }, { api_key: 'k2' }],
      note: 'token=abc123',
    }) as Record<string, unknown>;

    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted.nested).toEqual({ password: REDACTED, ok: 1 });
    expect(redacted.list).toEqual([{ apiKey: REDACTED }, { api_key: REDACTED }]);
    expect(redacted.note).toBe(`token=${REDACTED}`);
  });

  it('keeps primitive values and dates intact', () => {
    const when = new Date('2026-01-02T00:00:00.000Z');
    const redacted = redactValue({ count: 2, enabled: true, missing: null, when });
    expect(redacted).toEqual({ count: 2, enabled: true, missing: null, when });
  });

  it('replaces objects that exceed the depth budget', () => {
    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let index = 0; index < 8; index += 1) {
      deep = { child: deep };
    }
    const serialized = JSON.stringify(redactValue(deep));
    expect(serialized).toContain(REDACTED);
  });
});

describe('redactRecord', () => {
  it('redacts top level credential fields', () => {
    expect(redactRecord({ cookie: 'session=abc', token: 'abc', user: 'alice' })).toEqual({
      cookie: REDACTED,
      token: REDACTED,
      user: 'alice',
    });
  });
});

describe('maskSecret', () => {
  it('shows the first and last four characters for long secrets', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd…mnop');
  });

  it('hides short secrets entirely', () => {
    expect(maskSecret('short')).toBe(REDACTED);
    expect(maskSecret('12345678')).toBe(REDACTED);
  });
});
