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

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

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

function qqRule(): MessageRule {
  const now = new Date().toISOString();
  return {
    id: 'rule_qq_default',
    name: 'QQ 默认',
    enabled: true,
    priority: 100,
    platforms: ['qq-official'],
    conversationKinds: ['private', 'group'],
    groupIds: [],
    channelIds: [],
    userIds: [],
    trigger: {},
    response: {
      enabled: true,
      allowProactive: false,
      allowPrivate: true,
      allowGroup: true,
      allowChannel: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('QQ official bot <-> OneBot bridge integration', () => {
  let runtime: BridgeRuntime;
  let store: TempStorage;
  let fetchMock: FetchMock;
  let clientSocket: WebSocket;
  let events: Array<Record<string, unknown>>;
  let responses: Array<Record<string, unknown>>;

  beforeEach(async () => {
    FakeSocket.reset();
    process.env['TEST_QQ_APP_ID'] = 'app-1';
    process.env['TEST_QQ_APP_SECRET'] = 'test-app-secret';
    process.env['TEST_ONEBOT_TOKEN'] = 'onebot-secret';

    fetchMock = createFetchMock((request) => {
      if (request.url === TOKEN_URL) {
        return { body: { access_token: 'qq-token', expires_in: 7_200 } };
      }
      if (request.url.includes('/files')) {
        return { body: { file_info: 'file-info-1', ttl: 300 } };
      }
      if (request.url.includes('/messages')) {
        return { body: { id: `qq-sent-${fetchMock.calls.length}` } };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    store = createTempStorage();
    const config = createTestConfig({
      qq: {
        ...DEFAULT_APP_CONFIG.qq,
        enabled: true,
        appIdEnv: 'TEST_QQ_APP_ID',
        appSecretEnv: 'TEST_QQ_APP_SECRET',
        allowProactivePrivate: true,
        allowProactiveGroup: false,
        receiveAllGroupMessages: false,
      },
    });

    runtime = new BridgeRuntime({
      config,
      storage: store.storage,
      logger: createSilentLogger(),
      transport: { fetchImpl: fetchMock.fetch, createSocket: createFakeSocketFactory() },
    });
    registerActions(runtime.registry, runtime);
    store.storage.rules.create(qqRule());
    runtime.invalidateRules();
    await runtime.start();

    const gatewaySocket = FakeSocket.latest();
    gatewaySocket.open();
    gatewaySocket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    gatewaySocket.receive({ op: 0, s: 1, t: 'READY', d: { session_id: 'qq-session' } });

    events = [];
    responses = [];
    const address = runtime.getOneBotAddress();
    clientSocket = new WebSocket(`ws://127.0.0.1:${address?.port ?? 0}/onebot/v11/ws`, {
      headers: { Authorization: 'Bearer onebot-secret' },
    });
    clientSocket.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (payload['post_type'] === 'message') {
        events.push(payload);
      } else if (payload['post_type'] !== 'meta_event') {
        responses.push(payload);
      }
    });
    await new Promise<void>((resolve, reject) => {
      clientSocket.once('open', () => resolve());
      clientSocket.once('error', reject);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      clientSocket.once('close', () => resolve());
      clientSocket.close();
    }).catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    store.cleanup();
    delete process.env['TEST_QQ_APP_ID'];
    delete process.env['TEST_QQ_APP_SECRET'];
    delete process.env['TEST_ONEBOT_TOKEN'];
  });

  it('converts C2C_MESSAGE_CREATE into a OneBot private message', async () => {
    FakeSocket.latest().receive({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'c2c-msg-1',
        content: '你好',
        timestamp: new Date().toISOString(),
        author: { user_openid: 'user-openid-1' },
      },
    });

    const event = await waitFor(() => events[0], 3_000, 'c2c event');
    expect(event['post_type']).toBe('message');
    expect(event['message_type']).toBe('private');
    expect(event['sub_type']).toBe('friend');
    expect(Number(event['user_id'])).toBeGreaterThan(1_000_000_000);
    expect(event['group_id']).toBeUndefined();
    expect((event['message'] as Array<{ type: string }>)[0]?.type).toBe('text');
  });

  it('converts GROUP_AT_MESSAGE_CREATE into a OneBot group message', async () => {
    FakeSocket.latest().receive({
      op: 0,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'grp-msg-1',
        content: '在吗',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-1',
        author: { member_openid: 'member-1', member_role: 'member' },
      },
    });

    const event = await waitFor(() => events[0], 3_000, 'group event');
    expect(event['message_type']).toBe('group');
    expect(Number(event['group_id'])).toBeGreaterThan(2_000_000_000);
    expect(Number(event['user_id'])).toBeGreaterThan(1_000_000_000);
  });

  it('drops GROUP_MESSAGE_CREATE while full group mode is disabled', async () => {
    FakeSocket.latest().receive({
      op: 0,
      s: 2,
      t: 'GROUP_MESSAGE_CREATE',
      d: {
        id: 'grp-full-1',
        content: 'everyone chats',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-2',
        author: { member_openid: 'member-2' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toHaveLength(0);
  });

  it('replies passively to a group message using the remembered msg_id', async () => {
    FakeSocket.latest().receive({
      op: 0,
      s: 2,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'grp-msg-2',
        content: 'ping',
        timestamp: new Date().toISOString(),
        group_openid: 'group-openid-3',
        author: { member_openid: 'member-3' },
      },
    });
    const inbound = await waitFor(() => events[0], 3_000, 'group inbound');
    const groupId = Number(inbound['group_id']);

    clientSocket.send(
      JSON.stringify({
        action: 'send_group_msg',
        params: {
          group_id: groupId,
          message: [{ type: 'text', data: { text: 'pong' } }],
        },
        echo: 'group-send-1',
      }),
    );
    const reply = await waitFor(
      () => responses.find((entry) => entry['echo'] === 'group-send-1'),
      3_000,
      'group send response',
    );
    expect(reply['status']).toBe('async');

    const summary = await runtime.processQueueOnce();
    expect(summary.sent).toBe(1);

    const sendCall = fetchMock.callsTo('/v2/groups/group-openid-3/messages')[0];
    expect(sendCall).toBeDefined();
    expect(sendCall?.headers['authorization']).toBe('QQBot qq-token');
    expect(JSON.parse(sendCall?.body ?? '{}')).toMatchObject({
      content: 'pong',
      msg_id: 'grp-msg-2',
      msg_seq: 1,
    });
    expect(store.storage.deadLetters.count()).toBe(0);
  });

  it('turns a proactive group send into a permanent dead letter instead of retrying', async () => {
    const mapping = store.storage.ids.getOrCreate({
      platform: 'qq-official',
      nativeKind: 'group',
      nativeId: 'group-openid-4',
    });

    clientSocket.send(
      JSON.stringify({
        action: 'send_group_msg',
        params: {
          group_id: mapping.onebotId,
          message: [{ type: 'text', data: { text: 'broadcast' } }],
        },
        echo: 'proactive-1',
      }),
    );
    const response = await waitFor(
      () => responses.find((entry) => entry['echo'] === 'proactive-1'),
      3_000,
      'proactive response',
    );
    expect(response['status']).toBe('async');

    const pushed = await runtime.processQueueOnce();
    expect(pushed.dead).toBe(1);
    expect(pushed.retried).toBe(0);

    const deadLetters = store.storage.deadLetters.list({ page: 1, pageSize: 10 });
    expect(deadLetters.total).toBe(1);
    expect(deadLetters.items[0]?.reasonCode).toBe('capability_unsupported');
    expect(deadLetters.items[0]?.reasonMessage).toContain('proactive_messages_disabled');

    // No endless retry: the outbox no longer holds the record.
    expect(store.storage.outbox.list({ page: 1, pageSize: 10 }).total).toBe(0);
    const attempts = store.storage.attempts.count();
    expect(attempts).toBeLessThanOrEqual(1);
  });

  it('answers platform capabilities and status without leaking secrets', async () => {
    const view = runtime.getPlatformView('qq-official');
    expect(view.connection).toBe('connected');
    expect(view.capabilities.groupReceive).toBe(false);
    expect(view.capabilities.groupMentionReceive).toBe(true);
    expect(view.credentials.map((credential) => credential.state)).toEqual([
      'configured',
      'configured',
    ]);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('test-app-secret');
    expect(serialized).not.toContain('qq-token');
  });
});
