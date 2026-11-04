import type { FastifyInstance } from 'fastify';

import type { PagedResult, LogRow } from '@omni-relay/shared-types';

import { optionalString, parsePageQuery, type RouteContext, type RouteGuard } from './context.js';
import { toLogRow } from './mappers.js';

export function registerLogRoutes(
  app: FastifyInstance,
  context: RouteContext,
  guard: RouteGuard,
): void {
  app.get('/api/logs', { preHandler: guard }, async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const level = optionalString(query['level']);
    const platform = optionalString(query['platform']);
    const search = optionalString(query['search']);
    const { page, pageSize } = parsePageQuery(query);
    const result = context.runtime.storage.logs.list({
      ...(level ? { level } : {}),
      ...(platform ? { platform } : {}),
      ...(search ? { search } : {}),
      page,
      pageSize,
    });
    const body: PagedResult<LogRow> = {
      items: result.items.map(toLogRow),
      total: result.total,
      page,
      pageSize,
    };
    return body;
  });
}
