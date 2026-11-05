import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_APP_CONFIG, type MessageRule } from '@omni-relay/shared-types';

import { registerActions } from '../../apps/server/src/actions.js';
import { BridgeRuntime } from '../../apps/server/src/runtime.js';
import { FakeSocket, createFakeSocketFactory } from '../helpers/fake-socket.js';
import {
  createFetchMock,
  createSilentLogger,
  createTempStorage,
  createTestConfig,
  type FetchMock,
  type TempStorage,
} from '../helpers/harness.js';

const BOT_ID = '100100100';

interface OneBotClient {
  socket: WebSocket;
  events: Array<Record<string, unknown>>;
  responses: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function connectOneBot(port: number, token: string): Promise<OneBotClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const events: Array<Record<string, unknown>> = [];
  const responses: Array<Record<string, unknown>> = [];
  socket.on('message', (data: unknown) => {
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (payload['post_type'] === 'message') {
      events.push(payload);
    } else if (payload['post_type'] === 'meta_event') {
      // lifecycle + heartbeat are expected, ignore for assertions
    } else if (payload['echo'] !== undefined) {
      responses.push(payload);
    } else {
      responses.push(payload);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    events,
    responses,
    close: async () => {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
      });
    },
  };
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 3_000,
  label = 'condition',
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timeout waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function mentionRule(): MessageRule {
  const now = new Date().toISOString();
  return {
    id: 'rule_mention_only',
    name: '群内 @ 回复',
    enabled: true,
    priority: 100,
    platforms: ['discord'],
    conversationKinds: ['group', 'channel'],
    groupIds: [],
    channelIds: [],
    userIds: [],
    trigger: { requireMention: true },
    response: {
      enabled: true,
      allowProactive: false,
      allowPrivate: true,
      allowGroup: true,
      allowChannel: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('Discord <-> OneBot bridge integration', () => {
  let runtime: BridgeRuntime;
  let store: TempStorage;
  let fetchMock: FetchMock;
  let client: OneBotClient;

  beforeEach(async () => {
    FakeSocket.reset();
    process.env['TEST_DISCORD_TOKEN'] = 'test-bot-token';
    process.env['TEST_ONEBOT_TOKEN'] = 'onebot-secret';

    fetchMock = createFetchMock((request) => {
      if (request.url.endsWith('/users/@me')) {
        return { body: { id: BOT_ID, username: 'OmniBot' } };
      }
      if (request.url.includes('/channels/') && request.url.endsWith('/messages')) {
        return { body: { id: `discord-sent-${fetchMock.calls.length}`, channel_id: '300300300' } };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    store = createTempStorage();
    const config = createTestConfig({
      discord: {
        ...DEFAULT_APP_CONFIG.discord,
        enabled: true,
        tokenEnv: 'TEST_DISCORD_TOKEN',
        guildAllowlist: [],
        channelAllowlist: [],
      },
    });
    runtime = new BridgeRuntime({
      config,
      storage: store.storage,
      logger: createSilentLogger(),
      transport: { fetchImpl: fetchMock.fetch, createSocket: createFakeSocketFactory() },
    });
    registerActions(runtime.registry, runtime);
    runtime.storage.rules.create(mentionRule());
    runtime.invalidateRules();
    await runtime.start();

    const gatewaySocket = FakeSocket.latest();
    gatewaySocket.open();
    gatewaySocket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    gatewaySocket.receive({
      op: 0,
      s: 1,
      t: 'READY',
      d: { v: 10, user: { id: BOT_ID, username: 'OmniBot' }, session_id: 'sess-1', guilds: [] },
    });

    const address = runtime.getOneBotAddress();
    expect(address).not.toBeNull();
    client = await connectOneBot(address?.port ?? 0, 'onebot-secret');
  });

  afterEach(async () => {
    await client.close().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    store.cleanup();
    delete process.env['TEST_DISCORD_TOKEN'];
    delete process.env['TEST_ONEBOT_TOKEN'];
  });

  it('forwards a mentioned guild message as an OneBot group message', async () => {
    const gateway = FakeSocket.latest();
    gateway.receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: {
        id: '9001',
        channel_id: '300300300',
        guild_id: '400400400',
        content: 'hey <@100100100> ping',
        author: { id: '200200200', username: 'alice', bot: false },
        timestamp: new Date().toISOString(),
        channel: { id: '300300300', type: 0, name: 'general' },
        mentions: [{ id: BOT_ID, username: 'OmniBot' }],
      },
    });

    const event = await waitFor(() => client.events[0], 3_000, 'onebot message event');
    expect(event['post_type']).toBe('message');
    expect(event['message_type']).toBe('group');
    expect(typeof event['self_id']).toBe('number');
    expect(Number(event['group_id'])).toBeGreaterThan(2_000_000_000);
    expect(Number(event['user_id'])).toBeGreaterThan(1_000_000_000);

    const segments = event['message'] as Array<{ type: string; data: Record<string, unknown> }>;
    expect(segments.some((segment) => segment.type === 'text')).toBe(true);
    expect(segments.some((segment) => segment.type === 'at')).toBe(true);

    const recorded = store.storage.messages.list({ page: 1, pageSize: 10 });
    expect(recorded.items[0]?.status).toBe('sent');
    expect(recorded.items[0]?.platform).toBe('discord');
  });

  it('does not forward a message that does not mention the bot (mention_only policy)', async () => {
    const gateway = FakeSocket.latest();
    gateway.receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: {
        id: '9002',
        channel_id: '300300300',
        guild_id: '400400400',
        content: 'just chatting',
        author: { id: '200200200', username: 'alice', bot: false },
        timestamp: new Date().toISOString(),
        channel: { id: '300300300', type: 0, name: 'general' },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.events).toHaveLength(0);

    const recorded = store.storage.messages.list({ page: 1, pageSize: 10 });
    expect(recorded.items[0]?.status).toBe('ignored');
    expect(recorded.items[0]?.reason).toContain('mention_required_missing');
  });

  it('deduplicates a repeated platform message id', async () => {
    const gateway = FakeSocket.latest();
    const payload = {
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: {
        id: '9003',
        channel_id: '300300300',
        guild_id: '400400400',
        content: 'hi <@100100100>',
        author: { id: '200200200', username: 'alice', bot: false },
        timestamp: new Date().toISOString(),
        channel: { id: '300300300', type: 0, name: 'general' },
        mentions: [{ id: BOT_ID, username: 'OmniBot' }],
      },
    };
    gateway.receive(payload);
    await waitFor(() => client.events[0], 3_000, 'first message');
    gateway.receive({ ...payload, s: 3 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(client.events).toHaveLength(1);
    expect(store.storage.messages.list({ page: 1, pageSize: 10 }).total).toBe(1);
  });

  it('answers OneBot actions and delivers send_msg through the outbox', async () => {
    const gateway = FakeSocket.latest();
    gateway.receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: {
        id: '9004',
        channel_id: '300300300',
        guild_id: '400400400',
        content: 'hi <@100100100>',
        author: { id: '200200200', username: 'alice', bot: false },
        timestamp: new Date().toISOString(),
        channel: { id: '300300300', type: 0, name: 'general' },
        mentions: [{ id: BOT_ID, username: 'OmniBot' }],
      },
    });
    const inbound = await waitFor(() => client.events[0], 3_000, 'inbound event');
    const groupId = Number(inbound['group_id']);

    client.socket.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'login-1' }));
    const login = await waitFor(
      () => client.responses.find((entry) => entry['echo'] === 'login-1'),
      3_000,
      'login response',
    );
    expect(login['status']).toBe('ok');
    expect((login['data'] as { user_id: number }).user_id).toBeGreaterThan(0);

    client.socket.send(
      JSON.stringify({
        action: 'get_group_list',
        params: {},
        echo: 'groups-1',
      }),
    );
    const groups = await waitFor(
      () => client.responses.find((entry) => entry['echo'] === 'groups-1'),
      3_000,
      'group list',
    );
    const groupList = groups['data'] as Array<{ group_id: number; group_name: string }>;
    expect(groupList.some((group) => group.group_id === groupId)).toBe(true);

    client.socket.send(
      JSON.stringify({
        action: 'send_msg',
        params: {
          message_type: 'group',
          group_id: groupId,
          message: [{ type: 'text', data: { text: 'pong' } }],
        },
        echo: 'send-1',
      }),
    );
    const sendResponse = await waitFor(
      () => client.responses.find((entry) => entry['echo'] === 'send-1'),
      3_000,
      'send response',
    );
    expect(sendResponse['status']).toBe('async');
    expect(sendResponse['retcode']).toBe(1);
    const queuedId = (sendResponse['data'] as { message_id: string }).message_id;
    expect(queuedId.length).toBeGreaterThan(0);

    const summary = await runtime.processQueueOnce();
    expect(summary.sent).toBe(1);

    const sentCalls = fetchMock.callsTo('/channels/300300300/messages');
    expect(sentCalls).toHaveLength(1);
    expect(JSON.parse(sentCalls[0]?.body ?? '{}')).toMatchObject({ content: 'pong' });

    const stats = store.storage.outbox.stats();
    expect(stats.sent24h).toBe(1);
    expect(store.storage.deadLetters.count()).toBe(0);
  });

  it('rejects send_msg for an unknown OneBot id and for a disabled platform', async () => {
    client.socket.send(
      JSON.stringify({
        action: 'send_private_msg',
        params: { user_id: 424242, message: [{ type: 'text', data: { text: 'x' } }] },
        echo: 'unknown-1',
      }),
    );
    const unknown = await waitFor(
      () => client.responses.find((entry) => entry['echo'] === 'unknown-1'),
      3_000,
      'unknown user response',
    );
    expect(unknown['status']).toBe('failed');
    expect(unknown['retcode']).toBe(1404);

    await runtime.setPlatformEnabled('discord', false);
    client.socket.send(
      JSON.stringify({
        action: 'get_login_info',
        params: {},
        echo: 'after-disable',
      }),
    );
    const stillAlive = await waitFor(
      () => client.responses.find((entry) => entry['echo'] === 'after-disable'),
      3_000,
      'login after disable',
    );
    expect(stillAlive['status']).toBe('ok');

    const platform = runtime.getPlatformView('discord');
    expect(platform.enabled).toBe(false);
    expect(platform.connection).toBe('disabled');
  });

  it('exposes SPA-friendly platform and dashboard data without leaking credentials', async () => {
    const view = runtime.getPlatformView('discord');
    expect(view.credentials[0]?.state).toBe('configured');
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('test-bot-token');

    const status = runtime.getStatus();
    expect(status.onebot.clients).toBe(1);
    expect(status.platforms.find((entry) => entry.platform === 'discord')?.connection).toBe(
      'connected',
    );
  });
});
