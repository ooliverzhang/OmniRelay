import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AppConfig } from '@omni-relay/shared-types';

import type { AppLogger } from './logger.js';
import type { BridgeRuntime } from './runtime.js';
import { APP_NAME, APP_VERSION } from './version.js';

export interface HealthServerOptions {
  config: AppConfig;
  runtime: BridgeRuntime;
  logger: AppLogger;
}

export interface HealthServer {
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

/**
 * Operational endpoints on a dedicated port (`/healthz`, `/readyz`, `/status`)
 * so that a container orchestrator never needs console credentials.
 */
export function createHealthServer(options: HealthServerOptions): HealthServer {
  const { config, runtime, logger } = options;
  let server: Server | null = null;

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const url = request.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: { code: 'method_not_allowed', message: 'GET only' } });
      return;
    }

    if (path === '/healthz') {
      sendJson(response, 200, {
        status: 'ok',
        app: APP_NAME,
        version: APP_VERSION,
        uptimeSeconds: runtime.getStatus().uptimeSeconds,
      });
      return;
    }

    if (path === '/readyz') {
      const ready = runtime.isReady();
      const status = runtime.getStatus();
      sendJson(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'starting',
        checks: {
          onebotListening: status.onebot.clients >= 0,
          runtimeStarted: ready,
        },
      });
      return;
    }

    if (path === '/status') {
      const status = runtime.getStatus();
      const outbox = runtime.storage.outbox.stats();
      const discord = status.platforms.find((entry) => entry.platform === 'discord');
      const qq = status.platforms.find((entry) => entry.platform === 'qq-official');
      sendJson(response, 200, {
        app: APP_NAME,
        version: APP_VERSION,
        uptimeSeconds: status.uptimeSeconds,
        onebot: {
          connected: status.onebot.connected,
          clients: status.onebot.clients,
          last_event_at: status.onebot.lastEventAt,
          pending_actions: status.onebot.pendingActions,
        },
        discord: {
          enabled: discord?.enabled ?? false,
          connected: discord?.connection === 'connected',
          last_gateway_event_at: discord?.lastEventAt ?? null,
        },
        qq: {
          enabled: qq?.enabled ?? false,
          connected: qq?.connection === 'connected',
          last_gateway_event_at: qq?.lastEventAt ?? null,
        },
        queue: {
          pending: outbox.queued + outbox.retrying + outbox.sending,
          dead: outbox.dead,
          sent24h: outbox.sent24h,
          failed24h: outbox.failed24h,
        },
      });
      return;
    }

    sendJson(response, 404, { error: { code: 'not_found', message: 'unknown path' } });
  };

  return {
    start: async () => {
      server = createServer(handler);
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server?.once('error', onError);
        server?.listen(config.server.healthPort, config.server.host, () => {
          server?.off('error', onError);
          resolve();
        });
      });
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.server.healthPort;
      logger.info('health server listening', {
        event: 'health.listen',
        host: config.server.host,
        port,
      });
      return { host: config.server.host, port };
    },
    close: async () => {
      const current = server;
      server = null;
      if (!current) {
        return;
      }
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
      });
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}
