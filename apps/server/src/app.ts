import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from '@omni-relay/shared-types';

import type { AuthService } from './auth.js';
import type { AppLogger } from './logger.js';
import type { BridgeRuntime } from './runtime.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { createGuard, type RouteContext } from './routes/context.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerPlatformRoutes } from './routes/platforms.js';
import { registerQueueRoutes } from './routes/queues.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { APP_VERSION } from './version.js';

export interface CreateAppOptions {
  config: AppConfig;
  runtime: BridgeRuntime;
  auth: AuthService;
  logger: AppLogger;
}

/**
 * Builds the Fastify application: JSON API under `/api`, optional CORS for a
 * separate Vite dev server, and the statically hosted React console.
 */
export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const { config, runtime, auth, logger } = options;
  const context: RouteContext = { runtime, auth, logger, config };

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(fastifyCookie);

  if (config.web.corsOrigins.length > 0) {
    const allowed = new Set(config.web.corsOrigins);
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin && allowed.has(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type');
        reply.code(204).send();
      }
    });
  }

  const guard = createGuard(context);
  registerAuthRoutes(app, context);
  registerDashboardRoutes(app, context, guard);
  registerPlatformRoutes(app, context, guard);
  registerRuleRoutes(app, context, guard);
  registerConversationRoutes(app, context, guard);
  registerQueueRoutes(app, context, guard);
  registerLogRoutes(app, context, guard);
  registerSettingsRoutes(app, context, guard);

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as { statusCode?: number; message?: string };
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      logger.error('http handler failed', {
        event: 'web.error',
        route: `${request.method} ${request.url}`,
        error: error.message ?? 'unknown error',
      });
    }
    reply.code(status).send({
      error: {
        code: status >= 500 ? 'internal_error' : 'request_error',
        message: status >= 500 ? '服务器内部错误' : (error.message ?? '请求无效'),
      },
    });
  });

  const staticRoot = isAbsolute(config.web.staticDir)
    ? config.web.staticDir
    : resolve(config.web.staticDir);
  const indexHtml = join(staticRoot, 'index.html');
  const hasBuiltConsole = existsSync(indexHtml);

  if (hasBuiltConsole) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: '/',
      index: ['index.html'],
      wildcard: false,
      cacheControl: true,
      maxAge: '1h',
      immutable: false,
    });
    logger.info('serving built console', { event: 'web.static', root: staticRoot });
  } else {
    logger.warn('console bundle not found, API only', {
      event: 'web.static.missing',
      expected: indexHtml,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const url = request.url;
    if (url.startsWith('/api/') || url === '/api') {
      reply.code(404).send({ error: { code: 'not_found', message: '接口不存在' } });
      return;
    }
    if (hasBuiltConsole && request.method === 'GET') {
      reply.type('text/html').sendFile('index.html');
      return;
    }
    if (request.method === 'GET') {
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(
          [
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />',
            `<title>OmniRelay ${APP_VERSION}</title></head><body>`,
            '<h1>OmniRelay API 正在运行</h1>',
            '<p>前端尚未构建。开发模式请运行 <code>npm run web:dev</code>，',
            '生产模式请运行 <code>npm run web:build</code> 后重新启动。</p>',
            '<p>健康检查：<code>/healthz</code>、<code>/readyz</code>、<code>/status</code></p>',
            '</body></html>',
          ].join(''),
        );
      return;
    }
    reply.code(404).send({ error: { code: 'not_found', message: '未找到资源' } });
  });

  return app;
}
