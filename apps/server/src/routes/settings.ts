import type { FastifyInstance } from 'fastify';

import { REPLY_POLICY_MODES, type SettingsUpdateRequest } from '@omni-relay/shared-types';
import { z } from 'zod';

import type { RouteContext, RouteGuard } from './context.js';

const patchSchema = z
  .object({
    replyPolicy: z
      .object({
        defaultMode: z.enum(REPLY_POLICY_MODES).optional(),
        allowPrivateWithoutMention: z.boolean().optional(),
        allowGroupWithoutMention: z.boolean().optional(),
        allowChannelWithoutMention: z.boolean().optional(),
        whitelistUserIds: z.array(z.string()).optional(),
        whitelistGroupIds: z.array(z.string()).optional(),
      })
      .partial()
      .strict()
      .optional(),
    rules: z
      .object({
        enabled: z.boolean().optional(),
        defaultAction: z.literal('ignore').optional(),
        stopOnFirstMatch: z.boolean().optional(),
      })
      .partial()
      .strict()
      .optional(),
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(20).optional(),
        initialDelayMs: z.number().int().min(100).max(600_000).optional(),
        maxDelayMs: z.number().int().min(100).max(3_600_000).optional(),
        jitterRatio: z.number().min(0).max(1).optional(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export function registerSettingsRoutes(
  app: FastifyInstance,
  context: RouteContext,
  guard: RouteGuard,
): void {
  app.get('/api/settings', { preHandler: guard }, async () => {
    return context.runtime.getSettingsView();
  });

  app.patch('/api/settings', { preHandler: guard }, async (request, reply) => {
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: {
          code: 'invalid_settings',
          message: parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; '),
        },
      };
    }
    const updated = context.runtime.updateSettings(parsed.data as SettingsUpdateRequest);
    context.logger.info('settings updated', {
      event: 'settings.update',
      keys: Object.keys(parsed.data),
    });
    return updated;
  });
}
