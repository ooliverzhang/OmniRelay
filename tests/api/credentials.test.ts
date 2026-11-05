import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@omni-relay/shared-types';

import { createApp } from '../../apps/server/src/app.js';
import { registerActions } from '../../apps/server/src/actions.js';
import { AuthService, hashPassword } from '../../apps/server/src/auth.js';
import { createEnvFileStore } from '../../apps/server/src/env-file.js';
import { BridgeRuntime } from '../../apps/server/src/runtime.js';
import {
  createSilentLogger,
  createTempStorage,
  createTestConfig,
  type TempStorage,
} from '../helpers/harness.js';

const PASSWORD = 'credential-test-password';
const FAKE_DISCORD_TOKEN = 'test-discord-token-abcdefghijklmnop.qrstuv.wxyz0123456789';

interface Harness {
  app: FastifyInstance;
  runtime: BridgeRuntime;
  store: TempStorage;
  cookie: string;
  envDir: string;
  envPath: string;
}

async function buildHarness(options: { allowConsoleWrite?: boolean } = {}): Promise<Harness> {
  const envDir = mkdtempSync(join(tmpdir(), 'omni-relay-creds-'));
  const envPath = join(envDir, '.env');
  writeFileSync(envPath, '# managed by test\nEXISTING_KEY="keep-me"\n', 'utf8');

  const store = createTempStorage();
  const config = createTestConfig({
    discord: { ...DEFAULT_APP_CONFIG.discord, enabled: false, tokenEnv: 'DISCORD_BOT_TOKEN' },
    qq: {
      ...DEFAULT_APP_CONFIG.qq,
      enabled: false,
      appIdEnv: 'QQ_APP_ID',
      appSecretEnv: 'QQ_APP_SECRET',
    },
  });
  config.credentials = {
    envFile: envPath,
    allowConsoleWrite: options.allowConsoleWrite ?? true,
  };

  const logger = createSilentLogger();
  const runtime = new BridgeRuntime({
    config,
    storage: store.storage,
    logger,
    env: { ...process.env },
    transport: { fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch },
  });
  registerActions(runtime.registry, runtime);
  await runtime.start();

  const credentials = createEnvFileStore({ filePath: envPath });
  const auth = new AuthService({
    adminAuth: true,
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: 'credential-test-secret',
    ttlSeconds: 3_600,
  });
  const app = await createApp({ config, runtime, auth, logger, credentials });

  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: PASSWORD },
  });
  const rawCookie = login.headers['set-cookie'];
  const setCookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  const cookie = (setCookie ?? '').split(';')[0] ?? '';

  return { app, runtime, store, cookie, envDir, envPath };
}

function envContent(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('platform credential API', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.app.close();
      await harness.runtime.stop().catch(() => undefined);
      harness.store.cleanup();
      rmSync(harness.envDir, { recursive: true, force: true });
      delete process.env['DISCORD_BOT_TOKEN'];
      delete process.env['QQ_APP_ID'];
      delete process.env['QQ_APP_SECRET'];
      delete process.env['ONEBOT_BRIDGE_TOKEN'];
      harness = null;
    }
  });

  it('writes an allowed key to .env and returns a masked view', async () => {
    harness = await buildHarness();
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { DISCORD_BOT_TOKEN: FAKE_DISCORD_TOKEN } },
    });

    expect(response.statusCode).toBe(200);
    const content = envContent(harness.envPath);
    expect(content).toContain('DISCORD_BOT_TOKEN=');
    expect(content).toContain(FAKE_DISCORD_TOKEN);
    // existing content is preserved
    expect(content).toContain('# managed by test');
    expect(content).toContain('EXISTING_KEY="keep-me"');

    // The response must never leak the plaintext token.
    expect(response.body).not.toContain(FAKE_DISCORD_TOKEN);

    const body = response.json() as {
      credentials: Array<{ env: string; state: string; writable: boolean; masked: string | null }>;
    };
    const token = body.credentials.find((entry) => entry.env === 'DISCORD_BOT_TOKEN');
    expect(token?.state).toBe('configured');
    expect(token?.writable).toBe(true);
    expect(token?.masked).not.toBeNull();
    expect(token?.masked).not.toBe(FAKE_DISCORD_TOKEN);
    expect(token?.masked).toContain('…');
  });

  it('applies the credential to the live runtime environment', async () => {
    harness = await buildHarness();
    await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/qq-official/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { QQ_APP_ID: '102030405', QQ_APP_SECRET: 'test-app-secret-value' } },
    });

    const view = harness.runtime.getPlatformView('qq-official');
    expect(view.credentials.map((credential) => credential.state)).toEqual([
      'configured',
      'configured',
    ]);
    expect(harness.runtime.getPlatformConnection('qq-official').enabled).toBe(false);
  });

  it('rejects keys outside the platform allowlist with 400', async () => {
    harness = await buildHarness();
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { NODE_OPTIONS: '--require ./evil.js' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_credential_key' } });
    expect(envContent(harness.envPath)).not.toContain('NODE_OPTIONS');
  });

  it('rejects an over-long value and control characters', async () => {
    harness = await buildHarness();
    const tooLong = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { DISCORD_BOT_TOKEN: 'x'.repeat(600) } },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: { code: 'invalid_credential_value' } });

    const injected = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { DISCORD_BOT_TOKEN: 'abc\nEVIL_KEY=1' } },
    });
    expect(injected.statusCode).toBe(400);
    expect(envContent(harness.envPath)).not.toContain('EVIL_KEY');
  });

  it('rejects empty values and an unknown platform', async () => {
    harness = await buildHarness();
    const empty = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { DISCORD_BOT_TOKEN: '   ' } },
    });
    expect(empty.statusCode).toBe(400);

    const unknown = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/telegram/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { TELEGRAM_TOKEN: 'x' } },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: 'unsupported_platform' } });
  });

  it('returns 401 without a session', async () => {
    harness = await buildHarness();
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      payload: { values: { DISCORD_BOT_TOKEN: 'test-token' } },
    });
    expect(response.statusCode).toBe(401);
    expect(envContent(harness.envPath)).not.toContain('DISCORD_BOT_TOKEN');
  });

  it('returns 403 when console writes are disabled', async () => {
    harness = await buildHarness({ allowConsoleWrite: false });
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { DISCORD_BOT_TOKEN: 'test-token-value-123' } },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'credential_write_disabled' } });
    expect(envContent(harness.envPath)).not.toContain('DISCORD_BOT_TOKEN');
  });

  it('marks credentials as read-only when console writes are disabled', async () => {
    harness = await buildHarness({ allowConsoleWrite: false });
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/platforms/discord',
      headers: { cookie: harness.cookie },
    });
    const body = response.json() as { credentials: Array<{ writable: boolean }> };
    expect(body.credentials.every((credential) => credential.writable === false)).toBe(true);
  });

  it('deletes a credential and removes the key from .env', async () => {
    harness = await buildHarness();
    await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { DISCORD_BOT_TOKEN: FAKE_DISCORD_TOKEN } },
    });
    expect(envContent(harness.envPath)).toContain('DISCORD_BOT_TOKEN');

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: '/api/platforms/discord/credentials/DISCORD_BOT_TOKEN',
      headers: { cookie: harness.cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(envContent(harness.envPath)).not.toContain('DISCORD_BOT_TOKEN');

    const body = removed.json() as { credentials: Array<{ env: string; state: string }> };
    const token = body.credentials.find((entry) => entry.env === 'DISCORD_BOT_TOKEN');
    expect(token?.state).toBe('missing');
  });

  it('rejects deleting a key outside the allowlist', async () => {
    harness = await buildHarness();
    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/platforms/discord/credentials/PATH',
      headers: { cookie: harness.cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(envContent(harness.envPath)).toContain('EXISTING_KEY');
  });

  it('never exposes plaintext credentials through GET /api/platforms', async () => {
    harness = await buildHarness();
    await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/discord/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { DISCORD_BOT_TOKEN: FAKE_DISCORD_TOKEN } },
    });

    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/platforms',
      headers: { cookie: harness.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(FAKE_DISCORD_TOKEN);
    // The masked preview keeps the first/last characters only.
    expect(list.body).toMatch(/test…6789|test…/);
  });

  it('creates backups and keeps at most five of them', async () => {
    harness = await buildHarness();
    for (let index = 0; index < 8; index += 1) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: '/api/platforms/discord/credentials',
        headers: { cookie: harness.cookie },
        payload: { values: { DISCORD_BOT_TOKEN: `test-token-value-${index}abc` } },
      });
      expect(response.statusCode).toBe(200);
    }
    const backups = readdirSync(harness.envDir).filter((name) => name.startsWith('.env.bak-'));
    expect(backups.length).toBeLessThanOrEqual(5);
  });

  it('writes the onebot bridge token under the onebot target', async () => {
    harness = await buildHarness();
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/platforms/onebot/credentials',
      headers: { cookie: harness.cookie },
      payload: { values: { ONEBOT_BRIDGE_TOKEN: 'test-onebot-token-value' } },
    });
    expect(response.statusCode).toBe(200);
    expect(envContent(harness.envPath)).toContain('ONEBOT_BRIDGE_TOKEN');
    expect(response.body).not.toContain('test-onebot-token-value');
  });
});
