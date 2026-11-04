import { loadConfig } from './config.js';
import { AuthService } from './auth.js';
import { createApp } from './app.js';
import { createHealthServer } from './health.js';
import { createLogger } from './logger.js';
import { registerActions } from './actions.js';
import { BridgeRuntime } from './runtime.js';
import { APP_NAME, APP_VERSION } from './version.js';
import { openStorage } from '@omni-relay/storage';

/**
 * Process entry point.
 *
 * Startup order matters: the logger exists before storage so that storage
 * failures are visible, and the runtime starts before the HTTP layer so the
 * console never reports a half-initialised bridge.
 */
async function main(): Promise<void> {
  const { config, configPath, warnings } = loadConfig();
  const bootstrapLogger = createLogger({ config, persistToStorage: false });
  bootstrapLogger.info(`${APP_NAME} ${APP_VERSION} starting`, {
    event: 'process.start',
    configPath: configPath ?? '(defaults)',
  });
  for (const warning of warnings) {
    bootstrapLogger.warn(warning, { event: 'config.warning' });
  }

  const storage = openStorage({
    sqlitePath: config.storage.sqlitePath,
    logger: bootstrapLogger,
  });
  const logger = createLogger({ config, storage });

  try {
    storage.migrate();
    storage.dedupe.prune();
    storage.logs.prune();
    storage.messages.prune(config.storage.messageRetentionDays);
  } catch (error) {
    logger.error('storage maintenance failed', {
      event: 'storage.maintenance',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const runtime = new BridgeRuntime({ config, storage, logger });
  registerActions(runtime.registry, runtime);

  const passwordHash = config.web.adminPasswordHashEnv
    ? (process.env[config.web.adminPasswordHashEnv] ?? null)
    : null;
  const sessionSecret = config.web.sessionSecretEnv
    ? (process.env[config.web.sessionSecretEnv] ?? null)
    : null;
  if (config.web.adminAuth && !sessionSecret) {
    logger.warn('web session secret is not set, using an ephemeral secret', {
      event: 'web.session.ephemeral',
      env: config.web.sessionSecretEnv,
    });
  }

  const auth = new AuthService({
    adminAuth: config.web.adminAuth,
    passwordHash,
    sessionSecret,
    ttlSeconds: config.web.sessionTtlSeconds,
  });

  const health = createHealthServer({ config, runtime, logger });
  let app: Awaited<ReturnType<typeof createApp>> | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutdown requested', { event: 'process.shutdown', signal });
    try {
      await app?.close();
    } catch (error) {
      logger.warn('http server close failed', {
        event: 'process.shutdown.http',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await health.close();
    } catch {
      // ignored
    }
    try {
      await runtime.stop();
    } catch (error) {
      logger.warn('runtime stop failed', {
        event: 'process.shutdown.runtime',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      storage.close();
    } catch {
      // ignored
    }
    logger.info('shutdown complete', { event: 'process.shutdown.done' });
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT').then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => process.exit(0));
  });

  await runtime.start();
  await health.start();

  if (config.web.enabled) {
    app = await createApp({ config, runtime, auth, logger });
    await app.listen({ host: config.web.host, port: config.web.port });
    logger.info('web console listening', {
      event: 'web.listen',
      host: config.web.host,
      port: config.web.port,
      authRequired: config.web.adminAuth,
    });
  } else {
    logger.warn('web console disabled', { event: 'web.disabled' });
  }

  logger.info('omni-relay is ready', {
    event: 'process.ready',
    onebotPort: config.server.onebotPort,
    healthPort: config.server.healthPort,
    webPort: config.web.enabled ? config.web.port : null,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[omni-relay] fatal startup error: ${message}\n`);
  process.exitCode = 1;
});
