import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_APP_CONFIG,
  type MessageRule,
  type UnifiedSegment,
} from '@omni-relay/shared-types';
import { normalizeQqMessage } from '@omni-relay/core';

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

function ruleFor(platform: 'discord' | 'qq-official'): MessageRule {
  const now = new Date().toISOString();
  return {
    id: `rule_${platform}`,
    name: `${platform} rule`,
    enabled: true,
    priority: 100,
    platforms: [platform],
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
      allowChannel: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe('optional OneBot actions (get_msg / delete_msg / get_group_member_list)', () => {
  let runtime: BridgeRuntime;
  let store: TempStorage;
  let fetchMock: FetchMock;
  let socket: WebSocket;
  let events: Array<Record<string, unknown>>;
  let responses: Array<Record<string, unknown>>;

  async function call(params: {
    action: string;
    payload?: Record<string, unknown>;
    echo: string;
  }): Promise<Record<string, unknown>> {
    socket.send(
      JSON.stringify({ action: params.action, params: params.payload ?? {}, echo: params.echo }),
    );
    return waitFor(
      () => responses.find((entry) => entry['echo'] === params.echo),
      3_000,
      `${params.action} response`,
    );
  }

  function inboundDiscord(payload: Record<string, unknown>): void {
    FakeSocket.latest().receive({
      op: 0,
      s: 2,
      t: 'MESSAGE_CREATE',
      d: {
        channel_id: '300300300',
        guild_id: '400400400',
        author: { id: '200200200', username: 'alice', bot: false },
        timestamp: new Date().toISOString(),
        channel: { id: '300300300', type: 0, name: 'general' },
        ...payload,
      },
    });
  }

  beforeEach(async () => {
    FakeSocket.reset();
    process.env['TEST_DISCORD_TOKEN'] = 'test-bot-token';
    process.env['TEST_QQ_APP_ID'] = 'app-1';
    process.env['TEST_QQ_APP_SECRET'] = 'test-app-secret';
    process.env['TEST_ONEBOT_TOKEN'] = 'onebot-secret';

    fetchMock = createFetchMock((request) => {
      if (request.url.endsWith('/users/@me')) {
        return { body: { id: BOT_ID, username: 'OmniBot' } };
      }
      if (request.method === 'DELETE' && request.url.includes('/messages/')) {
        return { status: 204 };
      }
      if (request.url.includes('/messages')) {
        return { body: { id: `sent-${fetchMock.calls.length}`, channel_id: '300300300' } };
      }
      if (request.url === 'https://bots.qq.com/app/getAppAccessToken') {
        return { body: { access_token: 'qq-token', expires_in: 7_200 } };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    store = createTempStorage();
    const config = createTestConfig({
      discord: {
        ...DEFAULT_APP_CONFIG.discord,
        enabled: true,
        tokenEnv: 'TEST_DISCORD_TOKEN',
      },
    });
    runtime = new BridgeRuntime({
      config,
      storage: store.storage,
      logger: createSilentLogger(),
      transport: { fetchImpl: fetchMock.fetch, createSocket: createFakeSocketFactory() },
    });
    registerActions(runtime.registry, runtime);
    store.storage.rules.create(ruleFor('discord'));
    runtime.invalidateRules();
    await runtime.start();

    const gateway = FakeSocket.latest();
    gateway.open();
    gateway.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    gateway.receive({
      op: 0,
      s: 1,
      t: 'READY',
      d: { v: 10, user: { id: BOT_ID, username: 'OmniBot' }, session_id: 'sess', guilds: [] },
    });

    events = [];
    responses = [];
    const address = runtime.getOneBotAddress();
    socket = new WebSocket(`ws://127.0.0.1:${address?.port ?? 0}/onebot/v11/ws`, {
      headers: { Authorization: 'Bearer onebot-secret' },
    });
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
      } else if (payload['post_type'] !== 'meta_event') {
        responses.push(payload);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    }).catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    store.cleanup();
    delete process.env['TEST_DISCORD_TOKEN'];
    delete process.env['TEST_QQ_APP_ID'];
    delete process.env['TEST_QQ_APP_SECRET'];
    delete process.env['TEST_ONEBOT_TOKEN'];
  });

  it('get_msg replays a stored inbound message', async () => {
    inboundDiscord({ id: '7001', content: 'remember me <@100100100>' });
    const inbound = await waitFor(() => events[0], 3_000, 'inbound');
    expect(inbound['message_id']).toBe('7001');

    const response = await call({ action: 'get_msg', payload: { message_id: 7001 }, echo: 'gm-1' });
    expect(response['status']).toBe('ok');
    expect(response['retcode']).toBe(0);

    const data = response['data'] as Record<string, unknown>;
    expect(data['message_id']).toBe('7001');
    expect(data['message_type']).toBe('group');
    expect(Number(data['group_id'])).toBeGreaterThan(2_000_000_000);
    expect(Number(data['user_id'])).toBeGreaterThan(1_000_000_000);
    const segments = data['message'] as Array<{ type: string }>;
    expect(segments.some((segment) => segment.type === 'text')).toBe(true);
    expect(segments.some((segment) => segment.type === 'at')).toBe(true);
  });

  it('get_msg rejects an unknown message id with 1404', async () => {
    const response = await call({
      action: 'get_msg',
      payload: { message_id: 'nope' },
      echo: 'gm-2',
    });
    expect(response['status']).toBe('failed');
    expect(response['retcode']).toBe(1404);
  });

  it('get_msg validates the message_id parameter', async () => {
    const response = await call({ action: 'get_msg', payload: {}, echo: 'gm-3' });
    expect(response['status']).toBe('failed');
    expect(response['retcode']).toBe(1400);
  });

  it('delete_msg recalls a Discord message via the REST API', async () => {
    inboundDiscord({ id: '7002', content: 'delete me <@100100100>' });
    await waitFor(() => events[0], 3_000, 'inbound');

    const response = await call({
      action: 'delete_msg',
      payload: { message_id: '7002' },
      echo: 'dm-1',
    });
    expect(response['status']).toBe('ok');
    expect(response['retcode']).toBe(0);

    const deletes = fetchMock.calls.filter(
      (call) => call.method === 'DELETE' && call.url.endsWith('/channels/300300300/messages/7002'),
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.headers['authorization']).toBe('Bot test-bot-token');
  });

  it('delete_msg rejects unknown messages and malformed params', async () => {
    const missing = await call({
      action: 'delete_msg',
      payload: { message_id: '404404' },
      echo: 'dm-2',
    });
    expect(missing['status']).toBe('failed');
    expect(missing['retcode']).toBe(1404);

    const malformed = await call({ action: 'delete_msg', payload: {}, echo: 'dm-3' });
    expect(malformed['status']).toBe('failed');
    expect(malformed['retcode']).toBe(1400);
  });

  it('get_group_member_list returns only observed members', async () => {
    inboundDiscord({
      id: '7003',
      content: 'hi <@100100100>',
      author: { id: '555000', username: 'bob' },
    });
    const inbound = await waitFor(() => events[0], 3_000, 'inbound');
    const groupId = Number(inbound['group_id']);

    const response = await call({
      action: 'get_group_member_list',
      payload: { group_id: groupId },
      echo: 'gml-1',
    });
    expect(response['status']).toBe('ok');
    const members = response['data'] as Array<{
      group_id: number;
      user_id: number;
      nickname: string;
    }>;
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => member.group_id === groupId)).toBe(true);
    expect(members.some((member) => member.nickname === 'bob')).toBe(true);
  });

  it('get_group_member_list rejects an unknown group with 1404', async () => {
    const response = await call({
      action: 'get_group_member_list',
      payload: { group_id: 2999999999 },
      echo: 'gml-2',
    });
    expect(response['status']).toBe('failed');
    expect(response['retcode']).toBe(1404);
  });

  it('delete_msg reports 1405 for QQ, which has no recall API', async () => {
    // Disabled platform first: the guard reports the platform as unavailable.
    const disabledError = await runtime
      .deletePlatformMessage('qq-official', 'group-openid-1', 'qq-msg-1')
      .catch((caught: unknown) => caught);
    expect((disabledError as { code: string }).code).toBe('platform_unavailable');

    // Enabled platform without a recall endpoint: explicit unsupported answer.
    await runtime.setPlatformEnabled('qq-official', true);
    const enabledError = await runtime
      .deletePlatformMessage('qq-official', 'group-openid-1', 'qq-msg-1')
      .catch((caught: unknown) => caught);
    expect((enabledError as { code: string }).code).toBe('capability_unsupported');
    expect((enabledError as { retryable: boolean }).retryable).toBe(false);
  });
});

describe('QQ attachment expiry metadata', () => {
  it('forwards url_expires_at into the unified image segment', () => {
    const event = normalizeQqMessage({
      id: 'qq-img-1',
      msgSeq: 1,
      kind: 'c2c',
      userOpenId: 'user-openid-1',
      content: '',
      timestamp: '2024-05-01T10:00:00.000Z',
      attachments: [
        {
          url: 'https://cdn.qq.test/a.png',
          contentType: 'image/png',
          urlExpiresAt: '2024-05-01T11:00:00.000Z',
        },
      ],
    });
    const image = event.message.find(
      (segment): segment is Extract<UnifiedSegment, { type: 'image' }> => segment.type === 'image',
    );
    expect(image?.urlExpiresAt).toBe('2024-05-01T11:00:00.000Z');
  });

  it('forwards url_expires_at into the unified file segment', () => {
    const event = normalizeQqMessage({
      id: 'qq-file-1',
      kind: 'group',
      groupOpenId: 'group-openid-1',
      userOpenId: 'member-1',
      content: '',
      timestamp: '2024-05-01T10:00:00.000Z',
      attachments: [
        {
          url: 'https://cdn.qq.test/b.pdf',
          filename: 'b.pdf',
          contentType: 'application/pdf',
          size: 1_024,
          urlExpiresAt: '2024-05-01T12:00:00.000Z',
        },
      ],
    });
    const file = event.message.find(
      (segment): segment is Extract<UnifiedSegment, { type: 'file' }> => segment.type === 'file',
    );
    expect(file?.urlExpiresAt).toBe('2024-05-01T12:00:00.000Z');
    expect(file?.size).toBe(1_024);
  });
});
