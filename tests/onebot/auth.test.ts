import { describe, expect, it } from 'vitest';

import { verifyAccessToken } from '@omni-relay/onebot';

const TOKEN = 'test-token';

describe('verifyAccessToken', () => {
  it('treats a null expected token as "authentication disabled"', () => {
    expect(verifyAccessToken({ expected: null })).toEqual({
      ok: true,
      reason: null,
      source: null,
    });
    expect(verifyAccessToken({ authorization: 'Bearer whatever', expected: null })).toEqual({
      ok: true,
      reason: null,
      source: null,
    });
  });

  it('accepts a bearer token from the authorization header', () => {
    expect(verifyAccessToken({ authorization: `Bearer ${TOKEN}`, expected: TOKEN })).toEqual({
      ok: true,
      reason: null,
      source: 'header',
    });
  });

  it('matches the bearer prefix case insensitively and tolerates extra spaces', () => {
    expect(verifyAccessToken({ authorization: `bEaReR   ${TOKEN}   `, expected: TOKEN })).toEqual({
      ok: true,
      reason: null,
      source: 'header',
    });
  });

  it('accepts an access_token query parameter', () => {
    expect(
      verifyAccessToken({ url: `/onebot?access_token=${TOKEN}&foo=1`, expected: TOKEN }),
    ).toEqual({ ok: true, reason: null, source: 'query' });
    expect(
      verifyAccessToken({
        url: `ws://127.0.0.1:9000/onebot?access_token=${TOKEN}`,
        expected: TOKEN,
      }),
    ).toEqual({ ok: true, reason: null, source: 'query' });
  });

  it('reports missing credentials when nothing is supplied', () => {
    expect(verifyAccessToken({ expected: TOKEN })).toEqual({
      ok: false,
      reason: 'missing_credentials',
      source: null,
    });
    expect(verifyAccessToken({ url: '/onebot?foo=bar', expected: TOKEN })).toEqual({
      ok: false,
      reason: 'missing_credentials',
      source: null,
    });
    // A non-bearer authorization header carries no OneBot credential.
    expect(verifyAccessToken({ authorization: 'Basic dXNlcjpwYXNz', expected: TOKEN })).toEqual({
      ok: false,
      reason: 'missing_credentials',
      source: null,
    });
  });

  it('rejects a wrong header token', () => {
    expect(verifyAccessToken({ authorization: 'Bearer wrong-token', expected: TOKEN })).toEqual({
      ok: false,
      reason: 'invalid_credentials',
      source: 'header',
    });
  });

  it('rejects a wrong query token', () => {
    expect(verifyAccessToken({ url: '/onebot?access_token=wrong-token', expected: TOKEN })).toEqual(
      {
        ok: false,
        reason: 'invalid_credentials',
        source: 'query',
      },
    );
  });

  it('rejects tokens of a different length without throwing', () => {
    expect(() => verifyAccessToken({ authorization: 'Bearer t', expected: TOKEN })).not.toThrow();
    expect(verifyAccessToken({ authorization: 'Bearer t', expected: TOKEN }).ok).toBe(false);
  });

  it('never echoes the supplied token in the result', () => {
    const result = verifyAccessToken({
      authorization: 'Bearer leaked-token-value',
      url: '/onebot?access_token=leaked-token-value',
      expected: TOKEN,
    });
    expect(JSON.stringify(result)).not.toContain('leaked-token-value');
    expect(result.source).toBe('header');
  });

  it('ignores an empty bearer value and falls back to the query parameter', () => {
    expect(
      verifyAccessToken({
        authorization: 'Bearer   ',
        url: `/onebot?access_token=${TOKEN}`,
        expected: TOKEN,
      }),
    ).toEqual({ ok: true, reason: null, source: 'query' });
  });
});
