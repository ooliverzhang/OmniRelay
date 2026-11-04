import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import {
  CONVERSATION_KINDS,
  PLATFORMS,
  type ConversationKind,
  type MessageRule,
  type Platform,
  type ReplyPolicyMode,
  type RuleReorderRequest,
  type RuleTestRequest,
  type RuleToggleRequest,
  type RuleUpsertRequest,
} from '@omni-relay/shared-types';
import { buildEventFromTestInput, evaluateRuleSet, testMessageRule } from '@omni-relay/rules';
import { z } from 'zod';

import { toRuleView } from './mappers.js';
import type { RouteContext, RouteGuard } from './context.js';

const triggerSchema = z
  .object({
    requireMention: z.boolean().optional(),
    requireReplyToBot: z.boolean().optional(),
    textIncludes: z.array(z.string()).optional(),
    textPrefix: z.string().optional(),
    textRegex: z.string().optional(),
    messageTypes: z.array(z.enum(['text', 'image', 'file', 'mixed'])).optional(),
    userAllowlist: z.array(z.string()).optional(),
    groupAllowlist: z.array(z.string()).optional(),
    channelAllowlist: z.array(z.string()).optional(),
    privateOnly: z.boolean().optional(),
    groupOnly: z.boolean().optional(),
    ignoreBots: z.boolean().optional(),
  })
  .strict();

const responseSchema = z
  .object({
    enabled: z.boolean(),
    allowProactive: z.boolean(),
    allowPrivate: z.boolean(),
    allowGroup: z.boolean(),
    allowChannel: z.boolean(),
    maxResponseSegments: z.number().int().positive().optional(),
  })
  .strict();

const rateLimitSchema = z
  .object({
    maxMessages: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
    scope: z.enum(['user', 'conversation', 'platform', 'global']),
  })
  .strict();

const scheduleSchema = z
  .object({
    timezone: z.string().optional(),
    weekdays: z.array(z.number().int().min(1).max(7)).optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  })
  .strict();

const ruleInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(1_000_000).optional(),
    platforms: z.array(z.enum(PLATFORMS)).min(1),
    conversationKinds: z.array(z.enum(CONVERSATION_KINDS)).min(1),
    groupIds: z.array(z.string()).optional(),
    channelIds: z.array(z.string()).optional(),
    userIds: z.array(z.string()).optional(),
    trigger: triggerSchema.optional(),
    response: responseSchema.optional(),
    rateLimit: rateLimitSchema.optional(),
    schedule: scheduleSchema.optional(),
  })
  .strict();

const defaultTrigger = {
  requireMention: false,
  requireReplyToBot: false,
  textIncludes: [],
  messageTypes: [],
  userAllowlist: [],
  groupAllowlist: [],
  channelAllowlist: [],
  privateOnly: false,
  groupOnly: false,
  ignoreBots: true,
} satisfies Partial<MessageRule['trigger']>;

export function registerRuleRoutes(
  app: FastifyInstance,
  context: RouteContext,
  guard: RouteGuard,
): void {
  const { runtime } = context;

  app.get('/api/rules', { preHandler: guard }, async () => {
    return { items: runtime.storage.rules.list().map(toRuleView) };
  });

  app.post('/api/rules', { preHandler: guard }, async (request, reply) => {
    const parsed = ruleInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          code: 'invalid_rule',
          message: parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; '),
        },
      };
    }
    const now = new Date().toISOString();
    const input = parsed.data as RuleUpsertRequest;
    const rule: MessageRule = {
      id: `rule_${randomUUID()}`,
      name: input.name,
      enabled: input.enabled ?? true,
      priority: input.priority ?? runtime.storage.rules.nextPriority(),
      platforms: input.platforms,
      conversationKinds: input.conversationKinds,
      groupIds: input.groupIds ?? [],
      channelIds: input.channelIds ?? [],
      userIds: input.userIds ?? [],
      trigger: { ...defaultTrigger, ...(input.trigger ?? {}) },
      response: {
        enabled: input.response?.enabled ?? true,
        allowProactive: input.response?.allowProactive ?? false,
        allowPrivate: input.response?.allowPrivate ?? true,
        allowGroup: input.response?.allowGroup ?? true,
        allowChannel: input.response?.allowChannel ?? true,
        ...(input.response?.maxResponseSegments === undefined
          ? {}
          : { maxResponseSegments: input.response.maxResponseSegments }),
      },
      ...(input.rateLimit ? { rateLimit: input.rateLimit } : {}),
      ...(input.schedule ? { schedule: input.schedule } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const created = runtime.storage.rules.create(rule);
    runtime.invalidateRules();
    context.logger.info('rule created', { event: 'rule.create', ruleId: created.id });
    reply.code(201);
    return toRuleView(created);
  });

  app.get<{ Params: { id: string } }>('/api/rules/:id', { preHandler: guard }, async (request, reply) => {
    const rule = runtime.storage.rules.get(request.params.id);
    if (!rule) {
      reply.code(404);
      return { error: { code: 'not_found', message: '规则不存在' } };
    }
    return toRuleView(rule);
  });

  app.patch<{ Params: { id: string } }>(
    '/api/rules/:id',
    { preHandler: guard },
    async (request, reply) => {
      const existing = runtime.storage.rules.get(request.params.id);
      if (!existing) {
        reply.code(404);
        return { error: { code: 'not_found', message: '规则不存在' } };
      }
      const parsed = ruleInputSchema.partial().safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return {
          error: {
            code: 'invalid_rule',
            message: parsed.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
              .join('; '),
          },
        };
      }
      const patch = parsed.data as Partial<RuleUpsertRequest>;
      const updatedAt = new Date().toISOString();
      const next: Partial<MessageRule> = {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        ...(patch.platforms === undefined ? {} : { platforms: patch.platforms }),
        ...(patch.conversationKinds === undefined
          ? {}
          : { conversationKinds: patch.conversationKinds }),
        ...(patch.groupIds === undefined ? {} : { groupIds: patch.groupIds }),
        ...(patch.channelIds === undefined ? {} : { channelIds: patch.channelIds }),
        ...(patch.userIds === undefined ? {} : { userIds: patch.userIds }),
        ...(patch.trigger === undefined
          ? {}
          : { trigger: { ...defaultTrigger, ...patch.trigger } }),
        updatedAt,
      };
      if (patch.response !== undefined) {
        next.response = {
          enabled: patch.response.enabled ?? existing.response.enabled,
          allowProactive: patch.response.allowProactive ?? existing.response.allowProactive,
          allowPrivate: patch.response.allowPrivate ?? existing.response.allowPrivate,
          allowGroup: patch.response.allowGroup ?? existing.response.allowGroup,
          allowChannel: patch.response.allowChannel ?? existing.response.allowChannel,
          ...(patch.response.maxResponseSegments === undefined
            ? existing.response.maxResponseSegments === undefined
              ? {}
              : { maxResponseSegments: existing.response.maxResponseSegments }
            : { maxResponseSegments: patch.response.maxResponseSegments }),
        };
      }
      if (patch.rateLimit !== undefined) {
        next.rateLimit = patch.rateLimit;
      }
      if (patch.schedule !== undefined) {
        next.schedule = patch.schedule;
      }
      const updated = runtime.storage.rules.update(request.params.id, next);
      runtime.invalidateRules();
      context.logger.info('rule updated', { event: 'rule.update', ruleId: request.params.id });
      return toRuleView(updated ?? existing);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/rules/:id',
    { preHandler: guard },
    async (request, reply) => {
      const removed = runtime.storage.rules.remove(request.params.id);
      if (!removed) {
        reply.code(404);
        return { error: { code: 'not_found', message: '规则不存在' } };
      }
      runtime.invalidateRules();
      context.logger.info('rule deleted', { event: 'rule.delete', ruleId: request.params.id });
      return { ok: true };
    },
  );

  app.post('/api/rules/reorder', { preHandler: guard }, async (request, reply) => {
    const body = (request.body ?? {}) as RuleReorderRequest;
    if (!Array.isArray(body.orderedIds) || body.orderedIds.some((id) => typeof id !== 'string')) {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'orderedIds 必须是字符串数组' } };
    }
    const items = runtime.storage.rules.reorder(body.orderedIds);
    runtime.invalidateRules();
    context.logger.info('rules reordered', { event: 'rule.reorder', count: body.orderedIds.length });
    return { items: items.map(toRuleView) };
  });

  app.post<{ Params: { id: string } }>(
    '/api/rules/:id/toggle',
    { preHandler: guard },
    async (request, reply) => {
      const body = (request.body ?? {}) as RuleToggleRequest;
      if (typeof body.enabled !== 'boolean') {
        reply.code(400);
        return { error: { code: 'invalid_request', message: 'enabled 必须是布尔值' } };
      }
      const updated = runtime.storage.rules.update(request.params.id, {
        enabled: body.enabled,
        updatedAt: new Date().toISOString(),
      });
      if (!updated) {
        reply.code(404);
        return { error: { code: 'not_found', message: '规则不存在' } };
      }
      runtime.invalidateRules();
      return toRuleView(updated);
    },
  );

  app.post('/api/rules/test', { preHandler: guard }, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<RuleTestRequest>;
    const platform = body.platform;
    const conversationKind = body.conversationKind;
    const text = typeof body.text === 'string' ? body.text : '';
    if (
      (platform !== 'discord' && platform !== 'qq-official') ||
      !CONVERSATION_KINDS.includes(conversationKind as ConversationKind)
    ) {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'platform 或 conversationKind 非法' } };
    }
    if (typeof body.mention !== 'boolean') {
      reply.code(400);
      return { error: { code: 'invalid_request', message: 'mention 必须是布尔值' } };
    }

    const allRules = runtime.storage.rules.list();
    const selected =
      Array.isArray(body.ruleIds) && body.ruleIds.length > 0
        ? allRules.filter((rule) => body.ruleIds?.includes(rule.id))
        : allRules;

    const input = {
      platform: platform as Platform,
      conversationKind: conversationKind as ConversationKind,
      conversationId: body.conversationId ?? 'test-conversation',
      userId: body.userId ?? 'test-user',
      text,
      mention: body.mention,
      replyToBot: body.replyToBot ?? false,
      ...(body.timestamp === undefined ? {} : { timestamp: body.timestamp }),
      hasImage: body.hasImage ?? false,
      hasFile: body.hasFile ?? false,
    };

    const capabilities = runtime.getCapabilities(input.platform);
    const options = {
      replyPolicy: runtime.getReplyPolicy(),
      engine: runtime.getEngineConfig(),
      now: new Date(),
    };
    const result = testMessageRule(input, selected, capabilities, options);
    const evaluation = evaluateRuleSet(
      buildEventFromTestInput(input, new Date()),
      selected,
      capabilities,
      options,
    );

    return {
      ...result,
      evaluatedRules: evaluation.details.map((detail) => ({
        id: detail.ruleId,
        name: detail.name,
        matched: detail.matched,
        reason: detail.reason,
      })),
      appliedPolicyMode: result.appliedPolicyMode as ReplyPolicyMode,
    };
  });
}
