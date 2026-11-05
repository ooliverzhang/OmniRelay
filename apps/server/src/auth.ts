import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Console authentication.
 *
 * Passwords are never stored in the repository: the administrator exports a
 * scrypt hash (`npm run hash-password`) and the app verifies it in constant
 * time. Sessions are stateless HMAC-signed cookies, so no server-side session
 * store is required.
 */

export const SESSION_COOKIE_NAME = 'omni_relay_session';

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export interface SessionPayload {
  username: string | null;
  /** Unix epoch milliseconds. */
  exp: number;
  /** Issued-at, unix epoch milliseconds. */
  iat: number;
}

export interface SessionVerification {
  valid: boolean;
  username: string | null;
  expiresAt: string | null;
  reason: string | null;
}

/** Format: `scrypt$<N>$<r>$<p>$<saltB64url>$<hashB64url>`. */
export function hashPassword(password: string, salt?: Buffer): string {
  const saltBuffer = salt ?? randomBytes(16);
  const derived = scryptSync(password, saltBuffer, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    saltBuffer.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export function verifyPasswordHash(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(rawSalt, 'base64url');
    expected = Buffer.from(rawHash, 'base64url');
  } catch {
    return false;
  }
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}

export interface AuthServiceOptions {
  /** When false the console is open (local development only). */
  adminAuth: boolean;
  passwordHash: string | null;
  sessionSecret: string | null;
  ttlSeconds: number;
  now?: (() => Date) | undefined;
  username?: string | null | undefined;
}

export interface CreatedSession {
  cookieValue: string;
  expiresAt: string;
  maxAgeSeconds: number;
}

export class AuthService {
  private readonly adminAuth: boolean;
  private readonly passwordHash: string | null;
  private readonly sessionSecret: Buffer;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;
  private readonly username: string | null;

  constructor(options: AuthServiceOptions) {
    this.adminAuth = options.adminAuth;
    this.passwordHash = options.passwordHash;
    this.ttlSeconds = options.ttlSeconds;
    this.now = options.now ?? (() => new Date());
    this.username = options.username ?? null;
    this.sessionSecret = Buffer.from(
      options.sessionSecret ?? randomBytes(32).toString('base64url'),
      'utf8',
    );
  }

  get authRequired(): boolean {
    return this.adminAuth;
  }

  get sessionTtlSeconds(): number {
    return this.ttlSeconds;
  }

  verifyPassword(password: string): boolean {
    if (!this.adminAuth) {
      return true;
    }
    if (!this.passwordHash) {
      return false;
    }
    return verifyPasswordHash(password, this.passwordHash);
  }

  createSession(): CreatedSession {
    const issuedAt = this.now().getTime();
    const expiresAt = issuedAt + this.ttlSeconds * 1000;
    const payload: SessionPayload = { username: this.username, exp: expiresAt, iat: issuedAt };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = this.sign(body);
    return {
      cookieValue: `${body}.${signature}`,
      expiresAt: new Date(expiresAt).toISOString(),
      maxAgeSeconds: this.ttlSeconds,
    };
  }

  verifySession(cookieValue: string | undefined | null): SessionVerification {
    if (!this.adminAuth) {
      return { valid: true, username: this.username, expiresAt: null, reason: null };
    }
    if (!cookieValue) {
      return { valid: false, username: null, expiresAt: null, reason: 'missing_session' };
    }
    const separator = cookieValue.lastIndexOf('.');
    if (separator <= 0) {
      return { valid: false, username: null, expiresAt: null, reason: 'malformed_session' };
    }
    const body = cookieValue.slice(0, separator);
    const signature = cookieValue.slice(separator + 1);
    const expected = this.sign(body);
    if (!safeEqual(signature, expected)) {
      return { valid: false, username: null, expiresAt: null, reason: 'invalid_signature' };
    }
    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    } catch {
      return { valid: false, username: null, expiresAt: null, reason: 'invalid_payload' };
    }
    if (typeof payload.exp !== 'number' || payload.exp <= this.now().getTime()) {
      return { valid: false, username: null, expiresAt: null, reason: 'session_expired' };
    }
    return {
      valid: true,
      username: typeof payload.username === 'string' ? payload.username : null,
      expiresAt: new Date(payload.exp).toISOString(),
      reason: null,
    };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.sessionSecret).update(body).digest('base64url');
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
