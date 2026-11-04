import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '@omni-relay/shared-types';

import type { AuthService } from '../auth.js';
import { SESSION_COOKIE_NAME } from '../auth.js';
import type { AppLogger } from '../logger.js';
import type { BridgeRuntime } from '../runtime.js';

export interface RouteContext {
  runtime: BridgeRuntime;
  auth: AuthService;
  logger: AppLogger;
  config: AppConfig;
}

export type RouteGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Rejects unauthenticated requests with the standard error envelope. */
export function createGuard(context: RouteContext): RouteGuard {
  return async (request, reply) => {
    if (!context.auth.authRequired) {
      return;
    }
    const cookie = (request.cookies as Record<string, string | undefined> | undefined)?.[
      SESSION_COOKIE_NAME
    ];
    const session = context.auth.verifySession(cookie);
    if (!session.valid) {
      await reply.code(401).send({
        error: { code: 'unauthorized', message: '请先登录控制台' },
      });
    }
  };
}

export function parsePageQuery(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
} {
  const page = toPositiveInt(query['page'], 1);
  const pageSize = Math.min(toPositiveInt(query['pageSize'], 25), 200);
  return { page, pageSize };
}

export function toPositiveInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function badRequest(message: string): { error: { code: string; message: string } } {
  return { error: { code: 'bad_request', message } };
}
