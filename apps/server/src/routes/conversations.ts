import type { FastifyInstance } from 'fastify';

import {
  CONVERSATION_KINDS,
  PLATFORMS,
  isPlatform,
  type ConversationKind,
  type PagedResult,
  type ConversationRow,
  type MessageRow,
  type Platform,
} from '@omni-relay/shared-types';

import { parsePageQuery, optionalString, type RouteContext, type RouteGuard } from './context.js';
import { toConversationRow, toIdentityRow, toMessageRow } from './mappers.js';

export function registerConversationRoutes(
  app: FastifyInstance,
  context: RouteContext,
  guard: RouteGuard,
): void {
  const { runtime } = context;

  app.get('/api/conversations', { preHandler: guard }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const platform = parsePlatform(query['platform']);
    if (platform === 'invalid') {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'platform 非法' } };
    }
    const { page, pageSize } = parsePageQuery(query);
    const result = runtime.storage.messages.conversations({
      ...(platform ? { platform } : {}),
      ...(optionalString(query['search']) ? { search: optionalString(query['search']) } : {}),
      page,
      pageSize,
    });
    const body: PagedResult<ConversationRow> = {
      items: result.items.map(toConversationRow),
      total: result.total,
      page,
      pageSize,
    };
    return body;
  });

  app.get('/api/messages', { preHandler: guard }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const platform = parsePlatform(query['platform']);
    if (platform === 'invalid') {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'platform 非法' } };
    }
    const kindRaw = optionalString(query['conversationKind']);
    const conversationKind =
      kindRaw && CONVERSATION_KINDS.includes(kindRaw as ConversationKind)
        ? (kindRaw as ConversationKind)
        : undefined;
    const { page, pageSize } = parsePageQuery(query);
    const result = runtime.storage.messages.list({
      ...(platform ? { platform } : {}),
      ...(conversationKind ? { conversationKind } : {}),
      ...(optionalString(query['conversationNativeId'])
        ? { conversationNativeId: optionalString(query['conversationNativeId']) }
        : {}),
      ...(optionalString(query['senderNativeId'])
        ? { senderNativeId: optionalString(query['senderNativeId']) }
        : {}),
      ...(optionalString(query['status']) ? { status: optionalString(query['status']) } : {}),
      ...(optionalString(query['search']) ? { search: optionalString(query['search']) } : {}),
      page,
      pageSize,
    });
    const body: PagedResult<MessageRow> = {
      items: result.items.map(toMessageRow),
      total: result.total,
      page,
      pageSize,
    };
    return body;
  });

  app.get('/api/identities', { preHandler: guard }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const platform = parsePlatform(query['platform']);
    if (platform === 'invalid') {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'platform 非法' } };
    }
    const { page, pageSize } = parsePageQuery(query);
    const result = runtime.storage.ids.list({
      ...(platform ? { platform } : {}),
      ...(optionalString(query['search']) ? { search: optionalString(query['search']) } : {}),
      page,
      pageSize,
    });
    return {
      items: result.items.map(toIdentityRow),
      total: result.total,
      page,
      pageSize,
    };
  });
}

function parsePlatform(value: unknown): Platform | null | 'invalid' {
  const raw = optionalString(value);
  if (!raw) {
    return null;
  }
  if (!isPlatform(raw)) {
    return 'invalid';
  }
  return PLATFORMS.includes(raw) ? raw : 'invalid';
}
