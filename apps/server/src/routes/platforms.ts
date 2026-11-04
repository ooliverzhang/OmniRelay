import type { FastifyInstance } from 'fastify';

import {
  PLATFORMS,
  isPlatform,
  type PlatformUpdateRequest,
} from '@omni-relay/shared-types';

import type { RouteContext, RouteGuard } from './context.js';

export function registerPlatformRoutes(
  app: FastifyInstance,
  context: RouteContext,
  guard: RouteGuard,
): void {
  app.get('/api/platforms', { preHandler: guard }, async () => {
    return {
      items: PLATFORMS.map((platform) => context.runtime.getPlatformView(platform)),
    };
  });

  app.get<{ Params: { platform: string } }>(
    '/api/platforms/:platform',
    { preHandler: guard },
    async (request, reply) => {
      const platform = request.params.platform;
      if (!isPlatform(platform)) {
        reply.code(404);
        return { error: { code: 'not_found', message: `unknown platform: ${platform}` } };
      }
      return context.runtime.getPlatformView(platform);
    },
  );

  app.patch<{ Params: { platform: string } }>(
    '/api/platforms/:platform',
    { preHandler: guard },
    async (request, reply) => {
      const platform = request.params.platform;
      if (!isPlatform(platform)) {
        reply.code(404);
        return { error: { code: 'not_found', message: `unknown platform: ${platform}` } };
      }
      const body = (request.body ?? {}) as PlatformUpdateRequest;
      try {
        if (typeof body.enabled === 'boolean') {
          await context.runtime.setPlatformEnabled(platform, body.enabled);
        }
        if (body.settings) {
          await context.runtime.updatePlatformSettings(platform, body.settings);
        }
        context.logger.info('platform settings updated', {
          event: 'platform.update',
          platform,
          enabled: body.enabled ?? null,
        });
        return context.runtime.getPlatformView(platform);
      } catch (error) {
        reply.code(400);
        return {
          error: {
            code: 'update_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  );

  app.post<{ Params: { platform: string } }>(
    '/api/platforms/:platform/test',
    { preHandler: guard },
    async (request, reply) => {
      const platform = request.params.platform;
      if (!isPlatform(platform)) {
        reply.code(404);
        return { error: { code: 'not_found', message: `unknown platform: ${platform}` } };
      }
      const result = await context.runtime.testPlatform(platform);
      const view = context.runtime.getPlatformView(platform);
      return { ok: result.ok, message: result.message, connection: view.connection };
    },
  );

  app.post<{ Params: { platform: string } }>(
    '/api/platforms/:platform/reconnect',
    { preHandler: guard },
    async (request, reply) => {
      const platform = request.params.platform;
      if (!isPlatform(platform)) {
        reply.code(404);
        return { error: { code: 'not_found', message: `unknown platform: ${platform}` } };
      }
      const result = await context.runtime.reconnectPlatform(platform);
      const view = context.runtime.getPlatformView(platform);
      context.logger.info('platform reconnect requested', {
        event: 'platform.reconnect',
        platform,
        ok: result.ok,
      });
      return { ok: result.ok, message: result.message, connection: view.connection };
    },
  );
}
