import type { FastifyInstance } from 'fastify';

import {
  DELIVERY_STATUS,
  isPlatform,
  type PagedResult,
  type DeadLetterRow,
  type DeliveryStatus,
  type Platform,
  type QueueRow,
} from '@omni-relay/shared-types';

import { optionalString, parsePageQuery, type RouteContext, type RouteGuard } from './context.js';
import { toDeadLetterRow, toQueueRow } from './mappers.js';

export function registerQueueRoutes(
  app: FastifyInstance,
  context: RouteContext,
  guard: RouteGuard,
): void {
  const { runtime } = context;

  app.get('/api/queues', { preHandler: guard }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const platform = parsePlatform(query['platform']);
    if (platform === 'invalid') {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'platform 非法' } };
    }
    const statusRaw = optionalString(query['status']);
    const status =
      statusRaw && (DELIVERY_STATUS as readonly string[]).includes(statusRaw)
        ? (statusRaw as DeliveryStatus)
        : undefined;
    const { page, pageSize } = parsePageQuery(query);
    const result = runtime.storage.outbox.list({
      ...(platform ? { platform } : {}),
      ...(status ? { status } : {}),
      page,
      pageSize,
    });
    const body: PagedResult<QueueRow> = {
      items: result.items.map(toQueueRow),
      total: result.total,
      page,
      pageSize,
    };
    return body;
  });

  app.post<{ Params: { id: string } }>(
    '/api/queues/:id/retry',
    { preHandler: guard },
    async (request, reply) => {
      const record = runtime.storage.outbox.get(request.params.id);
      if (!record) {
        reply.code(404);
        return { error: { code: 'not_found', message: '队列记录不存在' } };
      }
      const preflight = preflightDelivery(context, record.platform, record.conversationKind, record.payload.proactive);
      if (preflight) {
        reply.code(409);
        return { error: { code: preflight.code, message: preflight.message } };
      }
      const requeued = runtime.storage.outbox.requeue(record.id);
      if (!requeued) {
        reply.code(409);
        return { error: { code: 'not_requeueable', message: '当前状态不可重试' } };
      }
      context.logger.info('outbox record requeued manually', {
        event: 'queue.retry',
        outboxId: record.id,
        platform: record.platform,
      });
      return { ok: true, message: '已重新入队' };
    },
  );

  app.get('/api/dead-letters', { preHandler: guard }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const platform = parsePlatform(query['platform']);
    if (platform === 'invalid') {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'platform 非法' } };
    }
    const { page, pageSize } = parsePageQuery(query);
    const result = runtime.storage.deadLetters.list({
      ...(platform ? { platform } : {}),
      page,
      pageSize,
    });
    const body: PagedResult<DeadLetterRow> = {
      items: result.items.map(toDeadLetterRow),
      total: result.total,
      page,
      pageSize,
    };
    return body;
  });

  app.post<{ Params: { id: string } }>(
    '/api/dead-letters/:id/retry',
    { preHandler: guard },
    async (request, reply) => {
      const record = runtime.storage.deadLetters.get(request.params.id);
      if (!record) {
        reply.code(404);
        return { error: { code: 'not_found', message: '死信不存在' } };
      }
      const preflight = preflightDelivery(
        context,
        record.platform,
        record.conversationKind,
        record.payload.proactive,
      );
      if (preflight) {
        reply.code(409);
        return { error: { code: preflight.code, message: preflight.message } };
      }
      const enqueued = runtime.storage.outbox.enqueue({
        platform: record.platform,
        conversationKind: record.conversationKind,
        conversationNativeId: record.conversationNativeId,
        senderNativeId: record.payload.proactive ? 'onebot' : 'onebot',
        payload: record.payload,
        bridgeMessageId: `retry_${record.id}`,
        maxAttempts: runtime.getRetryPolicy().maxAttempts,
      });
      runtime.storage.deadLetters.delete(record.id);
      context.logger.info('dead letter requeued manually', {
        event: 'deadletter.retry',
        deadLetterId: record.id,
        outboxId: enqueued.id,
      });
      return { ok: true, message: `已重新入队（${enqueued.id}）` };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/dead-letters/:id',
    { preHandler: guard },
    async (request, reply) => {
      const removed = runtime.storage.deadLetters.delete(request.params.id);
      if (!removed) {
        reply.code(404);
        return { error: { code: 'not_found', message: '死信不存在' } };
      }
      context.logger.info('dead letter deleted', {
        event: 'deadletter.delete',
        deadLetterId: request.params.id,
      });
      return { ok: true };
    },
  );
}

/**
 * Manual retries pass through exactly the same capability and rate-limit gates
 * as live traffic; a retry can never bypass the safety rules.
 */
function preflightDelivery(
  context: RouteContext,
  platform: Platform,
  conversationKind: 'private' | 'group' | 'channel',
  proactive: boolean,
): { code: string; message: string } | null {
  const { runtime } = context;
  if (!runtime.isPlatformEnabled(platform)) {
    return { code: 'platform_disabled', message: '平台已停用，无法重试' };
  }
  try {
    runtime.assertDeliveryAllowed(platform, conversationKind, proactive);
  } catch (error) {
    return {
      code: 'capability_unsupported',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const limit = runtime.getActionRateLimit();
  const decision = runtime.storage.rateLimits.consume(
    { scope: 'platform', scopeId: platform },
    limit,
    new Date(),
  );
  if (!decision.allowed) {
    return {
      code: 'rate_limited',
      message: `平台限流中，请 ${Math.ceil(decision.retryAfterMs / 1000)} 秒后重试`,
    };
  }
  return null;
}

function parsePlatform(value: unknown): Platform | null | 'invalid' {
  const raw = optionalString(value);
  if (!raw) {
    return null;
  }
  if (!isPlatform(raw)) {
    return 'invalid';
  }
  return raw;
}
