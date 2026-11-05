import { describe, expect, it } from 'vitest';

import { BridgeError, type PlatformCapabilities } from '@omni-relay/shared-types';
import {
  DiscordAdapter,
  DiscordGateway,
  DiscordRestClient,
  computeIntents,
} from '@omni-relay/adapters-discord';

import { createFetchMock, createSilentLogger } from '../helpers/harness.js';
import { FakeSocket, createFakeSocketFactory } from '../helpers/fake-socket.js';

const CAPABILITIES: PlatformCapabilities = {
  privateReceive: true,
  privateReply: true,
  privateProactiveSend: false,
  groupReceive: true,
  groupMentionReceive: true,
  groupReply: true,
  groupProactiveSend: true,
  broadcast: false,
};

function createRest(handler: Parameters<typeof createFetchMock>[0]) {
  const mock = createFetchMock(handler);
  const rest = new DiscordRestClient({
    token: 'test-bot-token',
    apiBaseUrl: 'https://discord.test/api/v10',
    timeoutMs: 1_000,
    fetchImpl: mock.fetch,
  });
  return { rest, mock };
}

describe('DiscordRestClient', () => {
  it('sends the bot token as an Authorization header and returns the message id', async () => {
    const { rest, mock } = createRest((request) => {
      if (request.url.endsWith('/users/@me')) {
        return { body: { id: 'bot-1', username: 'OmniBot' } };
      }
      return { body: { id: 'msg-9', channel_id: 'chan-1' } };
    });

    const user = await rest.getCurrentUser();
    expect(user.id).toBe('bot-1');

    const result = await rest.createMessage('chan-1', { content: 'hello' });
    expect(result.id).toBe('msg-9');

    const createCall = mock.callsTo('/channels/chan-1/messages')[0];
    expect(createCall?.headers['authorization']).toBe('Bot test-bot-token');
    expect(JSON.parse(createCall?.body ?? '{}')).toMatchObject({ content: 'hello' });
  });

  it('attaches files as multipart form data with payload_json', async () => {
    const { rest, mock } = createRest(() => ({ body: { id: 'msg-10', channel_id: 'chan-1' } }));
    await rest.createMessage('chan-1', {
      content: 'with image',
      files: [{ filename: 'a.png', data: new Uint8Array([1, 2, 3]), contentType: 'image/png' }],
    });
    const call = mock.callsTo('/channels/chan-1/messages')[0];
    expect(call?.formData).not.toBeNull();
    expect(call?.body).toBeNull();
    const form = call?.formData as FormData;
    expect(form.get('payload_json')).toContain('with image');
    expect(form.get('files[0]')).toBeInstanceOf(Blob);
  });

  it('maps 429 to a retryable rate_limited error with Retry-After', async () => {
    const { rest } = createRest(() => ({
      status: 429,
      body: { message: 'You are being rate limited.' },
      headers: { 'retry-after': '2' },
    }));

    await expect(rest.createMessage('chan-1', { content: 'x' })).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 2_000,
    });
  });

  it('maps 401 to a non-retryable unauthorized error', async () => {
    const { rest } = createRest(() => ({ status: 401, body: { message: '401: Unauthorized' } }));
    const error = await rest
      .createMessage('chan-1', { content: 'x' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe('unauthorized');
    expect((error as BridgeError).retryable).toBe(false);
  });

  it('rejects content longer than the Discord limit', async () => {
    const { rest } = createRest(() => ({ body: { id: 'never', channel_id: 'chan-1' } }));
    await expect(
      rest.createMessage('chan-1', { content: 'x'.repeat(2_001) }),
    ).rejects.toMatchObject({
      code: 'message_too_large',
    });
  });
});

describe('DiscordGateway', () => {
  it('identifies after HELLO and becomes connected on READY', async () => {
    FakeSocket.reset();
    const gateway = new DiscordGateway({
      token: 'test-bot-token',
      gatewayUrl: 'wss://gateway.test',
      intents: computeIntents({
        guilds: true,
        guildMessages: true,
        messageContent: true,
        directMessages: true,
      }),
      createSocket: createFakeSocketFactory(),
      baseReconnectDelayMs: 5,
      maxReconnectDelayMs: 5,
      rng: () => 0.5,
    });

    gateway.connect();
    const socket = FakeSocket.latest();
    socket.open();
    socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });

    const identify = socket.sentPayloads().find((payload) => payload['op'] === 2);
    expect(identify).toBeDefined();
    expect((identify?.['d'] as { token: string }).token).toBe('test-bot-token');
    expect((identify?.['d'] as { intents: number }).intents).toBe(
      1 | (1 << 9) | (1 << 12) | (1 << 15),
    );

    socket.receive({
      op: 0,
      s: 1,
      t: 'READY',
      d: { v: 10, user: { id: 'bot-1', username: 'OmniBot' }, session_id: 'sess-1', guilds: [] },
    });

    expect(gateway.getStatus().state).toBe('connected');
    expect(gateway.getStatus().userId).toBe('bot-1');
    await gateway.close();
  });

  it('dispatches MESSAGE_CREATE and ignores other events', async () => {
    FakeSocket.reset();
    const dispatched: string[] = [];
    const gateway = new DiscordGateway({
      token: 't',
      gatewayUrl: 'wss://gateway.test',
      intents: 1,
      createSocket: createFakeSocketFactory(),
      onDispatch: (name) => dispatched.push(name),
      rng: () => 0.5,
    });
    gateway.connect();
    const socket = FakeSocket.latest();
    socket.open();
    socket.receive({ op: 10, d: { heartbeat_interval: 40_000 } });
    socket.receive({ op: 0, s: 1, t: 'READY', d: { user: { id: 'bot-1' }, session_id: 's' } });
    socket.receive({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: 'm1' } });
    socket.receive({ op: 0, s: 3, t: 'TYPING_START', d: {} });

    expect(dispatched).toEqual(['MESSAGE_CREATE', 'TYPING_START']);
    await gateway.close();
  });

  it('stops on fatal close codes (invalid token) without reconnecting', async () => {
    FakeSocket.reset();
    const gateway = new DiscordGateway({
      token: 't',
      gatewayUrl: 'wss://gateway.test',
      intents: 1,
      createSocket: createFakeSocketFactory(),
      baseReconnectDelayMs: 5,
      rng: () => 0.5,
    });
    gateway.connect();
    const socket = FakeSocket.latest();
    socket.open();
    socket.serverClose(4004);

    expect(gateway.getStatus().state).toBe('error');
    expect(gateway.getStatus().lastError).toBe('invalid_bot_token');
    await gateway.close();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects with backoff on a transient close code', async () => {
    FakeSocket.reset();
    const gateway = new DiscordGateway({
      token: 't',
      gatewayUrl: 'wss://gateway.test',
      intents: 1,
      createSocket: createFakeSocketFactory(),
      baseReconnectDelayMs: 5,
      maxReconnectDelayMs: 5,
      rng: () => 0.5,
    });
    gateway.connect();
    const socket = FakeSocket.latest();
    socket.open();
    socket.serverClose(1006);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(gateway.getStatus().state).toBe('reconnecting');
    await gateway.close();
  });
});

describe('DiscordAdapter', () => {
  function createAdapter(
    options: {
      guildAllowlist?: string[];
      channelAllowlist?: string[];
      handler?: Parameters<typeof createFetchMock>[0];
    } = {},
  ) {
    const store = createRest(
      options.handler ?? (() => ({ body: { id: 'sent-1', channel_id: 'chan-1' } })),
    );
    const logger = createSilentLogger();
    const adapter = new DiscordAdapter({
      rest: store.rest,
      guildAllowlist: options.guildAllowlist ?? [],
      channelAllowlist: options.channelAllowlist ?? [],
      logger,
      fetchImpl: createFetchMock(() => ({
        status: 200,
        body: undefined,
        headers: { 'content-type': 'image/png' },
      })).fetch,
    });
    adapter.setBotUserId('100100100');
    return { adapter, mock: store.mock };
  }

  it('normalizes a guild message into a group conversation with mapped mentions', () => {
    const { adapter } = createAdapter();
    const event = adapter.handleDispatch('MESSAGE_CREATE', {
      id: 'm-1',
      channel_id: '300300300',
      guild_id: '400400400',
      content: 'hi <@100100100> look',
      author: { id: '200200200', username: 'alice', bot: false },
      timestamp: '2024-05-01T10:00:00.000Z',
      channel: { id: '300300300', type: 0, name: 'general' },
      mentions: [{ id: '100100100', username: 'OmniBot' }],
      attachments: [
        { url: 'https://cdn.test/a.png', filename: 'a.png', content_type: 'image/png' },
      ],
    });

    expect(event).not.toBeNull();
    expect(event?.platform).toBe('discord');
    expect(event?.conversation.kind).toBe('group');
    expect(event?.conversation.nativeId).toBe('300300300');
    expect(event?.conversation.displayName).toBe('general');
    expect(event?.sender.nativeId).toBe('200200200');
    expect(event?.mentionsBot).toBe(true);
    const segments = event?.message ?? [];
    expect(segments.some((segment) => segment.type === 'mention')).toBe(true);
    expect(segments.some((segment) => segment.type === 'image')).toBe(true);
    expect(
      segments
        .filter((segment) => segment.type === 'text')
        .map((s) => (s.type === 'text' ? s.text : ''))
        .join(''),
    ).not.toContain('<@100100100>');
  });

  it('normalizes a DM into a private conversation keyed by the author id', () => {
    const { adapter } = createAdapter();
    const event = adapter.handleDispatch('MESSAGE_CREATE', {
      id: 'm-2',
      channel_id: 'dm-channel',
      guild_id: null,
      content: 'hello there',
      author: { id: 'user-2', username: 'bob' },
      timestamp: '2024-05-01T10:00:00.000Z',
    });
    expect(event?.conversation.kind).toBe('private');
    expect(event?.conversation.nativeId).toBe('user-2');
    expect(event?.mentionsBot).toBe(false);
  });

  it('drops messages from guilds outside the allowlist', () => {
    const { adapter } = createAdapter({ guildAllowlist: ['guild-allowed'] });
    const event = adapter.handleDispatch('MESSAGE_CREATE', {
      id: 'm-3',
      channel_id: 'chan-9',
      guild_id: 'guild-other',
      content: 'x',
      author: { id: 'u', username: 'u' },
      timestamp: '2024-05-01T10:00:00.000Z',
    });
    expect(event).toBeNull();
  });

  it('sends to the channel directly and returns the platform message id', async () => {
    const { adapter, mock } = createAdapter();
    const result = await adapter.send(
      {
        kind: 'group',
        segments: [{ type: 'text', text: 'pong' }],
        proactive: true,
      },
      {
        platform: 'discord',
        conversationKind: 'group',
        conversationNativeId: 'chan-1',
        senderNativeId: 'onebot',
      },
    );

    expect(result.nativeMessageId).toBe('sent-1');
    const call = mock.callsTo('/channels/chan-1/messages')[0];
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ content: 'pong' });
  });

  it('resolves and caches the DM channel before sending a private message', async () => {
    const { adapter, mock } = createAdapter({
      handler: (request) => {
        if (request.url.endsWith('/users/@me/channels')) {
          return { body: { id: 'dm-channel-1', type: 1 } };
        }
        return { body: { id: 'sent-dm', channel_id: 'dm-channel-1' } };
      },
    });

    const target = {
      platform: 'discord' as const,
      conversationKind: 'private' as const,
      conversationNativeId: '700700700',
      senderNativeId: 'onebot',
    };
    await adapter.send(
      { kind: 'private', segments: [{ type: 'text', text: 'hi' }], proactive: false },
      target,
    );
    await adapter.send(
      { kind: 'private', segments: [{ type: 'text', text: 'again' }], proactive: false },
      target,
    );

    expect(mock.callsTo('/users/@me/channels')).toHaveLength(1);
    expect(mock.callsTo('/channels/dm-channel-1/messages')).toHaveLength(2);
  });

  it('rejects an empty outgoing message', async () => {
    const { adapter } = createAdapter();
    await expect(
      adapter.send(
        { kind: 'group', segments: [], proactive: true },
        {
          platform: 'discord',
          conversationKind: 'group',
          conversationNativeId: 'chan-1',
          senderNativeId: 'onebot',
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });

  it('exposes the capability matrix used by the planner', () => {
    expect(CAPABILITIES.groupReceive).toBe(true);
    expect(CAPABILITIES.privateProactiveSend).toBe(false);
  });
});
