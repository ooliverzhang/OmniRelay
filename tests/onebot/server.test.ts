import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createActionRegistry } from '@omni-relay/onebot';
import type { ActionHandlerResult, OneBotServer, OneBotServerOptions } from '@omni-relay/onebot';
import { BridgeError } from '@omni-relay/shared-types';
import type { OneBotMessageEvent } from '@omni-relay/shared-types';

import {
  attemptUpgrade,
  connectClient,
  delay,
  startServer,
  TEST_PATH,
  TEST_SELF_ID,
  TEST_TOKEN,
  waitUntil,
} from './support.js';
import type { ConnectOptions, RunningServer, TestClient } from './support.js';

const clients: TestClient[] = [];
const servers: OneBotServer[] = [];

async function running(overrides: Partial<OneBotServerOptions> = {}): Promise<RunningServer> {
  const created = await startServer(overrides);
  servers.push(created.server);
  return created;
}

async function connect(port: number, options: ConnectOptions = {}): Promise<TestClient> {
  const created = await connectClient(port, options);
  clients.push(created);
  return created;
}

function privateEvent(): OneBotMessageEvent {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: TEST_SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 1,
    user_id: 20002,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    sender: { user_id: 20002, nickname: 'Tester' },
  };
}

function groupEvent(): OneBotMessageEvent {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: TEST_SELF_ID,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 2,
    user_id: 20002,
    group_id: 30003,
    message: [{ type: 'text', data: { text: 'hi group' } }],
    raw_message: 'hi group',
    sender: { user_id: 20002, nickname: 'Tester', role: 'member' },
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('createOneBotServer', () => {
  it('starts on an ephemeral port with an empty status', async () => {
    const { server, port } = await running();
    expect(port).toBeGreaterThan(0);
    expect(server.getStatus()).toEqual({
      connected: false,
      clients: 0,
      lastEventAt: null,
      pendingActions: 0,
    });
  });

  it('rejects an upgrade that carries no credentials with HTTP 401', async () => {
    const { server, port } = await running();
    const result = await attemptUpgrade(`ws://127.0.0.1:${port}${TEST_PATH}`);

    expect(result.statusCode).toBe(401);
    expect(result.contentType).toContain('text/plain');
    expect(server.getStatus().clients).toBe(0);
  });

  it('rejects a wrong header token with HTTP 401', async () => {
    const { server, port } = await running();
    const result = await attemptUpgrade(`ws://127.0.0.1:${port}${TEST_PATH}`, {
      authorization: 'Bearer wrong-token',
    });

    expect(result.statusCode).toBe(401);
    expect(server.getStatus().clients).toBe(0);
  });

  it('rejects a wrong query token with HTTP 401', async () => {
    const { server, port } = await running();
    const result = await attemptUpgrade(
      `ws://127.0.0.1:${port}${TEST_PATH}?access_token=wrong-token`,
    );

    expect(result.statusCode).toBe(401);
    expect(server.getStatus().clients).toBe(0);
  });

  it('rejects an unknown websocket path with HTTP 404', async () => {
    const { port } = await running();
    const result = await attemptUpgrade(`ws://127.0.0.1:${port}/somewhere-else`, {
      authorization: `Bearer ${TEST_TOKEN}`,
    });

    expect(result.statusCode).toBe(404);
  });

  it('accepts a bearer header token', async () => {
    const { server, port } = await running();
    const client = await connect(port);

    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(server.getStatus().connected).toBe(true);
    expect(server.getStatus().clients).toBe(1);
  });

  it('accepts an access_token query parameter', async () => {
    const { server, port } = await running();
    const client = await connect(port, { source: 'query' });

    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(server.getStatus().clients).toBe(1);
  });

  it('sends a lifecycle meta event on connect', async () => {
    const { port } = await running();
    const client = await connect(port);

    const lifecycle = await client.waitFor<any>(
      (message) => message?.post_type === 'meta_event' && message?.meta_event_type === 'lifecycle',
    );
    expect(lifecycle.sub_type).toBe('connect');
    expect(lifecycle.self_id).toBe(TEST_SELF_ID);
    expect(typeof lifecycle.time).toBe('number');
  });

  it('broadcasts private message events to every client', async () => {
    const { server, port } = await running();
    const first = await connect(port);
    const second = await connect(port);

    expect(server.broadcastEvent(privateEvent())).toBe(2);

    const firstMessage = await first.waitFor<any>(
      (message) => message?.post_type === 'message' && message?.message_type === 'private',
    );
    const secondMessage = await second.waitFor<any>(
      (message) => message?.post_type === 'message' && message?.message_type === 'private',
    );
    expect(firstMessage.user_id).toBe(20002);
    expect(secondMessage.user_id).toBe(20002);
    expect(server.getStatus().lastEventAt).not.toBeNull();
  });

  it('broadcasts group message events', async () => {
    const { server, port } = await running();
    const client = await connect(port);

    expect(server.broadcastEvent(groupEvent())).toBe(1);

    const received = await client.waitFor<any>(
      (message) => message?.post_type === 'message' && message?.message_type === 'group',
    );
    expect(received.group_id).toBe(30003);
    expect(received.raw_message).toBe('hi group');
  });

  it('returns zero deliveries when nobody is connected', async () => {
    const { server } = await running();
    expect(server.broadcastEvent(privateEvent())).toBe(0);
    expect(server.getStatus().connected).toBe(false);
  });

  it('keeps clients connected beyond maxPendingActions', async () => {
    const { server, port } = await running({ maxPendingActions: 1 });
    await connect(port);
    await connect(port);
    await connect(port);

    expect(server.getStatus().clients).toBe(3);
  });

  it('dispatches get_login_info and correlates the echo', async () => {
    const { server, port, registry } = await running();
    registry.register('get_login_info', (params, context) => {
      expect(params).toEqual({});
      expect(context.clientId.length).toBeGreaterThan(0);
      return { data: { user_id: TEST_SELF_ID, nickname: 'OmniRelay' } };
    });
    const client = await connect(port);

    client.send({ action: 'get_login_info', echo: 'login-1' });

    const response = await client.waitFor<any>((message) => message?.echo === 'login-1');
    expect(response).toEqual({
      status: 'ok',
      retcode: 0,
      data: { user_id: TEST_SELF_ID, nickname: 'OmniRelay' },
      echo: 'login-1',
    });
    await waitUntil(() => server.getStatus().pendingActions === 0);
  });

  it('returns retcode 1 for asynchronous actions', async () => {
    const { port, registry } = await running();
    registry.register('send_private_msg', () => ({
      status: 'async',
      data: { message_id: '42' },
    }));
    const client = await connect(port);

    client.send({ action: 'send_private_msg', echo: 9 });

    const response = await client.waitFor<any>((message) => message?.echo === 9);
    expect(response).toEqual({
      status: 'async',
      retcode: 1,
      data: { message_id: '42' },
      echo: 9,
    });
  });

  it('returns 1404 for an unknown action', async () => {
    const { port } = await running();
    const client = await connect(port);

    client.send({ action: 'no_such_action', echo: 'unknown-1' });

    const response = await client.waitFor<any>((message) => message?.echo === 'unknown-1');
    expect(response).toEqual({
      status: 'failed',
      retcode: 1404,
      message: 'unknown_action:no_such_action',
      echo: 'unknown-1',
    });
  });

  it('maps a handler BridgeError to 1403 without leaking the token', async () => {
    const { port, registry } = await running();
    registry.register('secret_action', () => {
      throw new BridgeError({ code: 'forbidden', message: `denied for Bearer ${TEST_TOKEN}` });
    });
    const client = await connect(port);

    client.send({ action: 'secret_action', echo: 'secret-1' });

    const response = await client.waitFor<any>((message) => message?.echo === 'secret-1');
    expect(response.status).toBe('failed');
    expect(response.retcode).toBe(1403);
    expect(response.message).not.toContain(TEST_TOKEN);
    expect(response.message).toContain('[redacted]');
  });

  it('times out an action that never settles and returns 1504', async () => {
    const registry = createActionRegistry();
    registry.register('slow_action', () => new Promise<ActionHandlerResult>(() => {}));
    const { server, port } = await running({ registry, actionTimeoutMs: 50 });
    const client = await connect(port);

    client.send({ action: 'slow_action', echo: 'slow-1' });

    const response = await client.waitFor<any>((message) => message?.echo === 'slow-1');
    expect(response.status).toBe('failed');
    expect(response.retcode).toBe(1504);
    expect(response.message).toBe('action_timeout');
    await waitUntil(() => server.getStatus().pendingActions === 0);
  });

  it('ignores a handler response that arrives after the timeout', async () => {
    const registry = createActionRegistry();
    registry.register(
      'late_action',
      () =>
        new Promise<ActionHandlerResult>((resolve) => {
          setTimeout(() => resolve({ data: { late: true } }), 150);
        }),
    );
    const { server, port } = await running({ registry, actionTimeoutMs: 40 });
    const client = await connect(port);

    client.send({ action: 'late_action', echo: 'late-1' });

    const response = await client.waitFor<any>((message) => message?.echo === 'late-1');
    expect(response.retcode).toBe(1504);

    await delay(250);
    expect(client.messages.filter((message: any) => message?.echo === 'late-1')).toHaveLength(0);
    expect(server.getStatus().pendingActions).toBe(0);
  });

  it('cleans up pending actions when the client disconnects', async () => {
    const registry = createActionRegistry();
    let aborted = false;
    registry.register('hang_action', (_params, context) => {
      context.signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<ActionHandlerResult>(() => {});
    });
    const { server, port } = await running({ registry, actionTimeoutMs: 30_000 });
    const client = await connect(port);

    client.send({ action: 'hang_action', echo: 'hang-1' });
    await waitUntil(() => server.getStatus().pendingActions === 1);

    await client.close();
    await waitUntil(
      () => server.getStatus().pendingActions === 0 && server.getStatus().clients === 0,
    );
    expect(aborted).toBe(true);
  });

  it('rejects malformed JSON with 1400 and no echo', async () => {
    const { port } = await running();
    const client = await connect(port);

    client.ws.send('{not-json');

    const response = await client.waitFor<any>(
      (message) => message?.status === 'failed' && message?.message === 'invalid_json',
    );
    expect(response.retcode).toBe(1400);
    expect(response.echo).toBeUndefined();
  });

  it('rejects a JSON value that is not an action request with 1400', async () => {
    const { port } = await running();
    const client = await connect(port);

    client.send({ echo: 'invalid-1', foo: 'bar' });
    const withEcho = await client.waitFor<any>(
      (message) =>
        message?.status === 'failed' &&
        message?.message === 'invalid_action_request' &&
        message?.echo === 'invalid-1',
    );
    expect(withEcho.retcode).toBe(1400);

    client.send({ foo: 'bar' });
    const withoutEcho = await client.waitFor<any>(
      (message) =>
        message?.status === 'failed' &&
        message?.message === 'invalid_action_request' &&
        message?.echo === undefined,
    );
    expect(withoutEcho.retcode).toBe(1400);
    expect(withoutEcho.echo).toBeUndefined();
  });

  it('emits heartbeat meta events on the configured interval', async () => {
    const { port } = await running({ heartbeatIntervalSeconds: 1 });
    const client = await connect(port);

    const heartbeat = await client.waitFor<any>(
      (message) => message?.meta_event_type === 'heartbeat',
      4000,
    );
    expect(heartbeat.post_type).toBe('meta_event');
    expect(heartbeat.self_id).toBe(TEST_SELF_ID);
    expect(heartbeat.interval).toBe(1000);
    expect(heartbeat.status).toEqual({ online: true, good: true });
  });

  it('closes idempotently and drops every client', async () => {
    const { server, port } = await running();
    const client = await connect(port);

    await server.close();
    await server.close();

    expect(server.getStatus()).toEqual({
      connected: false,
      clients: 0,
      lastEventAt: null,
      pendingActions: 0,
    });
    await waitUntil(() => client.ws.readyState === WebSocket.CLOSED);
  });
});
