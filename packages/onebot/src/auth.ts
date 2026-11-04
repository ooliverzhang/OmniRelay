import { timingSafeEqual } from 'node:crypto';

import type { AccessTokenCheck, AccessTokenInput } from './contracts.js';

/**
 * OneBot 11 access token verification.
 *
 * The token may be supplied either through the `Authorization: Bearer <token>`
 * header or the `access_token` query parameter. Credential material is never
 * included in the returned value or in any log message.
 */

/** Prefix match is case insensitive and tolerates extra whitespace. */
const BEARER_PATTERN = /^bearer\s+(\S+)/i;

const ACCESS_TOKEN_PARAM = 'access_token';

/** Base used to parse protocol relative request targets such as `/ws?x=1`. */
const URL_BASE = 'http://onebot.local';

/** Constant time comparison; differing lengths short circuit to `false`. */
function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function tokenFromAuthorization(authorization: string | undefined): string | null {
  if (typeof authorization !== 'string' || authorization.trim().length === 0) {
    return null;
  }
  const match = BEARER_PATTERN.exec(authorization.trim());
  const token = match?.[1];
  if (token === undefined || token.length === 0) {
    return null;
  }
  return token;
}

function tokenFromUrl(url: string | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url, URL_BASE);
  } catch {
    return null;
  }
  const token = parsed.searchParams.get(ACCESS_TOKEN_PARAM);
  if (token === null || token.length === 0) {
    return null;
  }
  return token;
}

/**
 * Inspects an upgrade request and reports whether the supplied credential is
 * acceptable. `expected === null` disables authentication entirely.
 */
export function verifyAccessToken(input: AccessTokenInput): AccessTokenCheck {
  if (input.expected === null) {
    return { ok: true, reason: null, source: null };
  }

  const headerToken = tokenFromAuthorization(input.authorization);
  if (headerToken !== null) {
    return secureEquals(headerToken, input.expected)
      ? { ok: true, reason: null, source: 'header' }
      : { ok: false, reason: 'invalid_credentials', source: 'header' };
  }

  const queryToken = tokenFromUrl(input.url);
  if (queryToken !== null) {
    return secureEquals(queryToken, input.expected)
      ? { ok: true, reason: null, source: 'query' }
      : { ok: false, reason: 'invalid_credentials', source: 'query' };
  }

  return { ok: false, reason: 'missing_credentials', source: null };
}
