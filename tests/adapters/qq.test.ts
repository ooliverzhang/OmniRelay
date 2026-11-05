import { describe, expect, it } from 'vitest';

import { BridgeError } from '@omni-relay/shared-types';
import { QqAdapter, QqGateway, QqRestClient, QqTokenManager } from '@omni-relay/adapters-qq';

import { createFetchMock, createSilentLogger } from '../helpers/harness.js';
import { FakeSocket, createFakeSocketFactory } from '../helpers/fake-socket.js';

const TOKEN_URL = 'https://bots.qq.test/app/getAppAccessToken';
const API_BASE = 'https://api.qq.test';

function createStack(handler: Parameters<typeof createFetchMock>[0]) {
  const mock = createFetchMock(handler);
  const tokenManager = new QqTokenManager({
    appId: 'app-1',
    appSecret: 'test-app-secret',
    tokenUrl: TOKEN_URL,
    timeoutMs: 1_000,
    fetchImpl: mock.fetch,
  });
  const rest = new QqRestClient({
    appId: 'app-1',
    tokenManager,
    apiBaseUrl: API_BASE,
    timeoutMs: 1_000,
    fetchImpl: mock.fetch,
  });
  return { mock, tokenManager, rest };
}

const tokenOk = { body: { access_token: 'qq-access-token', expires_in: 7_200 } };

describe('QqTokenManager', () => {
  it('fetches the app access token with AppID + AppSecret and caches it', async () => {
    const { mock, tokenManager } = createStack(() => tokenOk);

    await expect(tokenManager.getAccessToken()).resolves.toBe('qq-access-token');
    await expect(tokenManager.getAccessToken()).resolves.toBe('qq-access-token');

    expect(mock.calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
    const call = mock.calls[0];
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      appId: 'app-1',
      clientSecret: 'test-app-secret',
    });
    expect(call?.headers['authorization']).toBeUndefined();
  });

  it('surfaces a non-retryable error when the token endpoint rejects the secret', async () => {
    const { tokenManager } = createStack(() => ({
      status: 400,
      body: { code: 11241, message: 'invalid app secret' },
    }));
    const error = await tokenManager.getAccessToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe('unauthorized');
    expect((error as BridgeError).retryable).toBe(false);
  });
});

describe('QqRestClient', () => {
  it('sends a passive group reply with msg_id and msg_seq', async () => {
    const { mock, rest } = createStack((request) => {
      if (request.url === TOKEN_URL) {
        return tokenOk;
      }
      return { body: { id: 'qq-msg-1', timestamp: '2024-05-01T10:00:00Z' } };
    });

    const result = await rest.sendMessage({
      conversationKind: 'group',
      openId: 'group-openid-1',
      content: 'hello',
      replyToMessageId: 'origin-msg',
      msgSeq: 1,
    });

    expect(result.id).toBe('qq-msg-1');
    const send = mock.callsTo('/v2/groups/group-openid-1/messages')[0];
    expect(send?.headers['authorization']).toBe('QQBot qq-access-token');
    expect(send?.headers['x-union-appid']).toBe('app-1');
    expect(JSON.parse(send?.body ?? '{}')).toEqual({
      msg_type: 0,
      content: 'hello',
      msg_id: 'origin-msg',
      msg_seq: 1,
    });
  });

  it('sends a proactive private message without msg_id', async () => {
    const { mock, rest } = createStack((request) =>
      request.url === TOKEN_URL ? tokenOk : { body: { id: 'qq-dm-1' } },
    );

    await rest.sendMessage({
      conversationKind: 'private',
      openId: 'user-openid-1',
      content: 'ping',
    });

    const send = mock.callsTo('/v2/users/user-openid-1/messages')[0];
    const body = JSON.parse(send?.body ?? '{}') as Record<string, unknown>;
    expect(body['msg_id']).toBeUndefined();
    expect(body['content']).toBe('ping');
  });

  it('refreshes the token once after a 401 and retries the send', async () => {
    let sendAttempts = 0;
    const { mock, rest } = createStack((request) => {
      if (request.url === TOKEN_URL) {
        return tokenOk;
      }
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return { status: 401, body: { code: 11241, message: 'token expired' } };
      }
      return { body: { id: 'qq-retry-1' } };
    });

    const result = await rest.sendMessage({
      conversationKind: 'private',
      openId: 'user-openid-2',
      content: 'retry me',
    });

    expect(result.id).toBe('qq-retry-1');
    expect(mock.calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
    expect(sendAttempts).toBe(2);
  });

  it('maps HTTP 429 to a retryable rate_limited error', async () => {
    const { rest } = createStack((request) =>
      request.url === TOKEN_URL
        ? tokenOk
        : {
            status: 429,
            body: { code: 304023, message: 'too many requests' },
            headers: { 'retry-after': '3' },
          },
    );

    await expect(
      rest.sendMessage({ conversationKind: 'private', openId: 'u', content: 'x' }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 3_000 });
  });

  it('maps quota business codes to a permanent quota_exceeded error', async () => {
    const { rest } = createStack((request) =>
      request.url === TOKEN_URL
        ? tokenOk
        : { status: 400, body: { code: 304030, message: '主动消息额度不足' } },
    );

    await expect(
      rest.sendMessage({ conversationKind: 'group', openId: 'g', content: 'x' }),
    ).rejects.toMatchObject({ code: 'quota_exceeded', retryable: false });
  });

  it('uploads media as multipart and returns file_info', async () => {
    const { mock, rest } = createStack((request) =>
      request.url === TOKEN_URL ? tokenOk : { body: { file_info: 'file-info-1', ttl: 300 } },
    );

    const upload = await rest.uploadMedia({
      conversationKind: 'group',
      openId: 'group-openid-2',
      data: new Uint8Array([9, 8, 7]),
      filename: 'photo.png',
      contentType: 'image/png',
      fileType: 1,
    });

    expect(upload.fileInfo).toBe('file-info-1');
    expect(upload.ttlSeconds).toBe(300);
    const call = mock.callsTo('/v2/groups/group-openid-2/files')[0];
    expect(call?.formData).not.toBeNull();
    const form = call?.formData as FormData;
    expect(form.get('file_type')).toBe('1');
    expect(form.get('srv_send_msg')).toBe('false');
    expect(form.get('file_data')).toBeInstanceOf(Blob);
  });
});

describe('QqGateway', () => {
  it('identifies with the QQBot token after HELLO and connects on READY', async () => {
    FakeSocket.reset();
    const gateway = new QqGateway({
      getAccessToken: async () => 'qq-access-token',
      gatewayUrl: 'wss://qq-gateway.test',
      intents: 1 << 25,
      createSocket: createFakeSocketFactory(),
      rng: () => 0.5,
    });

    gateway.connect();
    const socket = FakeSocket.latest();
    socket.open();
    socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const identify = socket.sentPayloads().find((payload) => payload['op'] === 2);
    expect((identify?.['d'] as { token: string }).token).toBe('QQBot qq-access-token');

    socket.receive({ op: 0, s: 1, t: 'READY', d: { session_id: 'qq-session' } });
    expect(gateway.getStatus().state).toBe('connected');
    expect(gateway.getStatus().sessionId).toBe('qq-session');
    await gateway.close();
  });
});

describe('QqAdapter', () => {
  function createAdapter(
    options: {
      groupAllowlist?: string[];
      allowProactiveGroup?: boolean;
      handler?: Parameters<typeof createFetchMock>[0];
    } = {},
  ) {
    const { mock, rest, tokenManager } = createStack(
      options.handler ??
        ((request) => (request.url === TOKEN_URL ? tokenOk : { body: { id: 'sent-1' } })),
    );
    const adapter = new QqAdapter({
      rest,
      groupAllowlist: options.groupAllowlist ?? [],
      allowProactivePrivate: true,
      allowProactiveGroup: options.allowProactiveGroup ?? false,
      logger: createSilentLogger(),
      passiveReplyWindowSeconds: 300,
    });
    return { adapter, mock, rest, tokenManager };
  }

  it('normalizes a C2C event into a private conversation with a passive reply window', () => {
    const { adapter } = createAdapter();
    const event = adapter.handleDispatch('C2C_MESSAGE_CREATE', {
      id: 'c2c-1',
      content: '哈喽',
      timestamp: '2024-05-01T10:00:00.000Z',
      author: { user_openid: 'user-openid-9' },
    });

    expect(event?.platform).toBe('qq-official');
    expect(event?.conversation.kind).toBe('private');
    expect(event?.conversation.nativeId).toBe('user-openid-9');
    expect(event?.mentionsBot).toBe(false);
    expect(event?.replyContext?.nativeMessageId).toBe('c2c-1');
    expect(event?.replyContext?.expiresAt).toBeDefined();
  });

  it('marks GROUP_AT events as mentions and keeps the group openid as conversation id', () => {
    const { adapter } = createAdapter();
    const event = adapter.handleDispatch('GROUP_AT_MESSAGE_CREATE', {
      id: 'grp-msg-1',
      content: '在吗',
      timestamp: 1_714_557_600,
      group_openid: 'group-openid-9',
      author: { member_openid: 'member-9', member_role: 'member' },
    });

    expect(event?.conversation.kind).toBe('group');
    expect(event?.conversation.nativeId).toBe('group-openid-9');
    expect(event?.mentionsBot).toBe(true);
    expect(event?.sender.role).toBe('member');
  });

  it('ignores groups outside the allowlist and unsupported event names', () => {
    const { adapter } = createAdapter({ groupAllowlist: ['group-allowed'] });
    expect(
      adapter.handleDispatch('GROUP_AT_MESSAGE_CREATE', {
        id: 'grp-msg-2',
        content: 'x',
        timestamp: 1_714_557_600,
        group_openid: 'group-other',
        author: { member_openid: 'm' },
      }),
    ).toBeNull();
    expect(adapter.handleDispatch('SOMETHING_ELSE', {})).toBeNull();
  });

  it('blocks proactive group messages when they are disabled', async () => {
    const { adapter } = createAdapter({ allowProactiveGroup: false });
    const error = await adapter
      .send(
        { kind: 'group', segments: [{ type: 'text', text: 'push' }], proactive: true },
        {
          platform: 'qq-official',
          conversationKind: 'group',
          conversationNativeId: 'group-openid-9',
          senderNativeId: 'onebot',
        },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe('capability_unsupported');
    expect((error as BridgeError).retryable).toBe(false);
  });

  it('splits long text into several messages and keeps the passive reply sequence', async () => {
    let counter = 0;
    const { adapter, mock } = createAdapter({
      allowProactiveGroup: true,
      handler: (request) => {
        if (request.url === TOKEN_URL) {
          return tokenOk;
        }
        counter += 1;
        return { body: { id: `qq-chunk-${counter}` } };
      },
    });

    const result = await adapter.send(
      { kind: 'group', segments: [{ type: 'text', text: 'x'.repeat(2_000) }], proactive: false },
      {
        platform: 'qq-official',
        conversationKind: 'group',
        conversationNativeId: 'group-openid-9',
        senderNativeId: 'onebot',
        replyToNativeMessageId: 'inbound-1',
      },
    );

    const sends = mock.callsTo('/v2/groups/group-openid-9/messages');
    expect(sends).toHaveLength(2);
    expect(result.nativeMessageId).toBe('qq-chunk-2');
    expect(JSON.parse(sends[0]?.body ?? '{}')).toMatchObject({ msg_id: 'inbound-1', msg_seq: 1 });
    expect(JSON.parse(sends[1]?.body ?? '{}')).toMatchObject({ msg_id: 'inbound-1', msg_seq: 2 });
  });
});
