import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@omni-relay/shared-types';

import { createApp } from '../../apps/server/src/app.js';
import { AuthService, hashPassword } from '../../apps/server/src/auth.js';
import { registerActions } from '../../apps/server/src/actions.js';
import { BridgeRuntime } from '../../apps/server/src/runtime.js';
import {
  createSilentLogger,
  createTempStorage,
  createTestConfig,
  type TempStorage,
} from '../helpers/harness.js';

const PASSWORD = 'correct-horse-battery';
const DISCORD_TOKEN = 'super-secret-bot-token-value';

interface Harness {
  app: FastifyInstance;
  runtime: BridgeRuntime;
  store: TempStorage;
  cookie: string;
}

async function buildHarness(): Promise<Harness> {
  const store = createTempStorage();
  const config = createTestConfig({
    discord: { ...DEFAULT_APP_CONFIG.discord, enabled: false, tokenEnv: 'TEST_DISCORD_TOKEN' },
  });
  const logger = createSilentLogger();
  const runtime = new BridgeRuntime({
    config,
    storage: store.storage,
    logger,
    transport: { fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch },
  });
  registerActions(runtime.registry, runtime);

  const auth = new AuthService({
    adminAuth: true,
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: 'unit-test-session-secret',
    ttlSeconds: 3_600,
  });
  const app = await createApp({ config, runtime, auth, logger });

  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: PASSWORD },
  });
  const rawCookie = login.headers['set-cookie'];
  const setCookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  const cookie = (setCookie ?? '').split(';')[0] ?? '';

  return { app, runtime, store, cookie };
}

describe('console API', () => {
  let harness: Harness;

  beforeEach(async () => {
    process.env['TEST_DISCORD_TOKEN'] = DISCORD_TOKEN;
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
    harness.store.cleanup();
    delete process.env['TEST_DISCORD_TOKEN'];
  });

  it('rejects unauthenticated API calls with 401', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/rules' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects a wrong password and accepts the correct one', async () => {
    const bad = await harness.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_credentials' } });

    const session = await harness.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: harness.cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, authRequired: true });
  });

  it('returns a dashboard summary with both platforms and a 24h trend', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { cookie: harness.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.platforms).toHaveLength(2);
    expect(body.platforms.map((entry: { platform: string }) => entry.platform).sort()).toEqual([
      'discord',
      'qq-official',
    ]);
    expect(body.queue).toMatchObject({
      queued: 0,
      sending: 0,
      retrying: 0,
      dead: 0,
      sent24h: 0,
      failed24h: 0,
    });
    expect(body.messages.trend).toHaveLength(24);
    expect(body.onebot).toMatchObject({ connected: false, clients: 0, pendingActions: 0 });
    expect(typeof body.generatedAt).toBe('string');
  });

  it('shows credential state but never the credential value', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/platforms',
      headers: { cookie: harness.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ platform: string; credentials: Array<{ state: string; env: string }> }>;
    };
    const discord = body.items.find((entry) => entry.platform === 'discord');
    expect(discord?.credentials[0]).toMatchObject({ env: 'TEST_DISCORD_TOKEN', state: 'configured' });
    expect(response.body).not.toContain(DISCORD_TOKEN);

    const settings = await harness.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: harness.cookie },
    });
    expect(settings.body).not.toContain(DISCORD_TOKEN);
    expect(settings.json()).toMatchObject({
      onebot: { accessTokenConfigured: false },
      web: { adminAuth: true },
      version: '0.1.0',
    });
  });

  it('supports rule CRUD, toggle, reorder and the rule tester', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: harness.cookie },
      payload: {
        name: '群内 @ 回复',
        platforms: ['discord'],
        conversationKinds: ['group'],
        trigger: { requireMention: true },
        response: { enabled: true, allowProactive: false, allowPrivate: true, allowGroup: true, allowChannel: true },
      },
    });
    expect(created.statusCode).toBe(201);
    const rule = created.json() as { id: string; priority: number; name: string };
    expect(rule.name).toBe('群内 @ 回复');
    expect(rule.priority).toBeGreaterThan(0);

    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: { cookie: harness.cookie },
    });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(1);

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/rules/${rule.id}`,
      headers: { cookie: harness.cookie },
      payload: { name: '改名后的规则', priority: 500 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: '改名后的规则', priority: 500 });

    const toggled = await harness.app.inject({
      method: 'POST',
      url: `/api/rules/${rule.id}/toggle`,
      headers: { cookie: harness.cookie },
      payload: { enabled: false },
    });
    expect(toggled.json()).toMatchObject({ enabled: false });

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: harness.cookie },
      payload: {
        name: '第二条',
        platforms: ['qq-official'],
        conversationKinds: ['private'],
      },
    });
    const secondId = (second.json() as { id: string }).id;

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/rules/reorder',
      headers: { cookie: harness.cookie },
      payload: { orderedIds: [secondId, rule.id] },
    });
    expect(reordered.statusCode).toBe(200);
    const items = (reordered.json() as { items: Array<{ id: string; priority: number }> }).items;
    expect(items[0]?.id).toBe(secondId);
    expect(items[0]?.priority).toBeGreaterThan(items[1]?.priority ?? 0);

    const testResult = await harness.app.inject({
      method: 'POST',
      url: '/api/rules/test',
      headers: { cookie: harness.cookie },
      payload: {
        platform: 'discord',
        conversationKind: 'group',
        text: 'hello there',
        mention: false,
      },
    });
    expect(testResult.statusCode).toBe(200);
    const evaluated = testResult.json() as {
      matched: boolean;
      decision: string;
      reason: string;
      evaluatedRules: Array<{ matched: boolean; reason: string }>;
    };
    expect(evaluated.matched).toBe(false);
    expect(evaluated.reason).toBe('mention_required_missing');
    expect(Array.isArray(evaluated.evaluatedRules)).toBe(true);

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: `/api/rules/${rule.id}`,
      headers: { cookie: harness.cookie },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
  });

  it('validates rule payloads and surfaces a 400 with details', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: harness.cookie },
      payload: { name: '', platforms: [], conversationKinds: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid_rule' } });
  });

  it('updates settings and persists the reply policy', async () => {
    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: harness.cookie },
      payload: {
        replyPolicy: { defaultMode: 'always', whitelistGroupIds: ['g-1'] },
        retry: { maxAttempts: 3 },
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      replyPolicy: { defaultMode: 'always', whitelistGroupIds: ['g-1'] },
      retry: { maxAttempts: 3 },
    });

    const rejected = await harness.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: harness.cookie },
      payload: { replyPolicy: { defaultMode: 'nonsense' } },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it('serves queue, dead-letter, identity, conversation and log listings', async () => {
    const queues = await harness.app.inject({
      method: 'GET',
      url: '/api/queues?page=1&pageSize=10',
      headers: { cookie: harness.cookie },
    });
    expect(queues.statusCode).toBe(200);
    expect(queues.json()).toMatchObject({ items: [], total: 0, page: 1, pageSize: 10 });

    const dead = await harness.app.inject({
      method: 'GET',
      url: '/api/dead-letters',
      headers: { cookie: harness.cookie },
    });
    expect(dead.statusCode).toBe(200);
    expect((dead.json() as { items: unknown[] }).items).toHaveLength(0);

    const identities = await harness.app.inject({
      method: 'GET',
      url: '/api/identities',
      headers: { cookie: harness.cookie },
    });
    expect(identities.statusCode).toBe(200);

    const conversations = await harness.app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: { cookie: harness.cookie },
    });
    expect(conversations.statusCode).toBe(200);

    harness.store.storage.logs.append({
      level: 'info',
      msg: 'bridge started',
      event: 'runtime.start',
      platform: 'discord',
    });
    harness.store.storage.logs.append({
      level: 'error',
      msg: 'discord gateway error',
      event: 'adapter.discord.error',
    });

    const logs = await harness.app.inject({
      method: 'GET',
      url: '/api/logs?level=info',
      headers: { cookie: harness.cookie },
    });
    expect(logs.statusCode).toBe(200);
    const logItems = (logs.json() as { items: Array<{ msg: string; level: string }> }).items;
    expect(logItems.length).toBeGreaterThan(0);
    expect(logItems.every((item) => item.level === 'info')).toBe(true);
  });

  it('rejects an invalid platform filter and unknown API routes', async () => {
    const badPlatform = await harness.app.inject({
      method: 'GET',
      url: '/api/queues?platform=telegram',
      headers: { cookie: harness.cookie },
    });
    expect(badPlatform.statusCode).toBe(400);

    const unknown = await harness.app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { cookie: harness.cookie },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('serves a placeholder page for / when the SPA bundle is absent', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('OmniRelay');
  });
});
