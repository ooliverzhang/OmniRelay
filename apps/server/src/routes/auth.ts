import type { FastifyInstance } from 'fastify';

import { SESSION_COOKIE_NAME } from '../auth.js';

import type { RouteContext } from './context.js';

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

/**
 * Console authentication endpoints.
 *
 * Login failures are throttled per remote address so a weak password cannot be
 * brute-forced remotely. The cookie is HttpOnly + SameSite=Lax and carries an
 * HMAC-signed, expiring session payload.
 */
export function registerAuthRoutes(app: FastifyInstance, context: RouteContext): void {
  const failures = new Map<string, { count: number; firstAt: number }>();

  app.get('/api/session', async (request) => {
    const cookie = readSessionCookie(request.cookies);
    const session = context.auth.verifySession(cookie);
    return {
      authenticated: context.auth.authRequired ? session.valid : true,
      authRequired: context.auth.authRequired,
      username: session.username,
      expiresAt: session.expiresAt,
    };
  });

  app.post('/api/login', async (request, reply) => {
    const remote = request.ip ?? 'unknown';
    const now = Date.now();
    const entry = failures.get(remote);
    if (entry && now - entry.firstAt < LOGIN_WINDOW_MS && entry.count >= LOGIN_MAX_FAILURES) {
      reply.code(429);
      return {
        error: {
          code: 'too_many_attempts',
          message: '登录尝试过于频繁，请稍后再试',
        },
      };
    }

    const body = (request.body ?? {}) as { password?: unknown; username?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!context.auth.verifyPassword(password)) {
      const current = failures.get(remote);
      if (!current || now - current.firstAt >= LOGIN_WINDOW_MS) {
        failures.set(remote, { count: 1, firstAt: now });
      } else {
        current.count += 1;
      }
      context.logger.warn('console login failed', {
        event: 'web.login.failed',
        remote,
      });
      reply.code(401);
      return { error: { code: 'invalid_credentials', message: '密码错误' } };
    }

    failures.delete(remote);
    const session = context.auth.createSession();
    reply.setCookie(SESSION_COOKIE_NAME, session.cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: session.maxAgeSeconds,
      secure: false,
    });
    context.logger.info('console login succeeded', { event: 'web.login', remote });
    return {
      authenticated: true,
      authRequired: context.auth.authRequired,
      username: typeof body.username === 'string' ? body.username : null,
      expiresAt: session.expiresAt,
    };
  });

  app.post('/api/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });
}

function readSessionCookie(cookies: unknown): string | undefined {
  if (typeof cookies !== 'object' || cookies === null) {
    return undefined;
  }
  const value = (cookies as Record<string, unknown>)[SESSION_COOKIE_NAME];
  return typeof value === 'string' ? value : undefined;
}
