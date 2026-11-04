import { describe, expect, it, vi } from 'vitest';

import { BridgeError } from '@omni-relay/shared-types';
import { createActionRegistry } from '@omni-relay/onebot';
import type { ActionContext, ActionHandlerResult } from '@omni-relay/onebot';

function makeContext(action: string, echo?: string | number): ActionContext {
  return {
    action,
    echo,
    clientId: 'client-1',
    receivedAt: new Date(),
    remoteAddress: '127.0.0.1',
    signal: new AbortController().signal,
  };
}

describe('createActionRegistry', () => {
  it('registers, reports and lists actions', () => {
    const registry = createActionRegistry();
    const handler = (): ActionHandlerResult => ({ data: { ok: true } });

    expect(registry.has('ping')).toBe(false);
    registry.register('ping', handler);
    expect(registry.has('ping')).toBe(true);
    expect(registry.list()).toEqual(['ping']);
  });

  it('throws when the same action is registered twice', () => {
    const registry = createActionRegistry();
    registry.register('ping', () => ({}));
    expect(() => registry.register('ping', () => ({}))).toThrow(/action_already_registered/);
  });

  it('dispatches an ok action with echo', async () => {
    const registry = createActionRegistry();
    registry.register('get_login_info', (params, context) => {
      expect(params).toEqual({});
      expect(context.action).toBe('get_login_info');
      expect(context.clientId).toBe('client-1');
      return { data: { user_id: 10001, nickname: 'OmniRelay' } };
    });

    const response = await registry.handle(
      { action: 'get_login_info', echo: 'login-1' },
      makeContext('get_login_info', 'login-1'),
    );
    expect(response).toEqual({
      status: 'ok',
      retcode: 0,
      data: { user_id: 10001, nickname: 'OmniRelay' },
      echo: 'login-1',
    });
  });

  it('returns status async with retcode 1', async () => {
    const registry = createActionRegistry();
    registry.register('send_msg', () => ({ status: 'async', data: { message_id: '42' } }));

    const response = await registry.handle(
      { action: 'send_msg', echo: 7 },
      makeContext('send_msg', 7),
    );
    expect(response).toEqual({
      status: 'async',
      retcode: 1,
      data: { message_id: '42' },
      echo: 7,
    });
  });

  it('passes a custom message through on success', async () => {
    const registry = createActionRegistry();
    registry.register('noop', () => ({ message: 'nothing to do' }));

    const response = await registry.handle({ action: 'noop' }, makeContext('noop'));
    expect(response).toEqual({ status: 'ok', retcode: 0, message: 'nothing to do' });
  });

  it('treats non object params as an empty object', async () => {
    const registry = createActionRegistry();
    let received: Record<string, unknown> | undefined;
    registry.register('params_probe', (params) => {
      received = params;
      return { data: params };
    });

    const response = await registry.handle(
      { action: 'params_probe', params: 'not-an-object' as unknown as Record<string, unknown> },
      makeContext('params_probe'),
    );
    expect(received).toEqual({});
    expect(response).toEqual({ status: 'ok', retcode: 0, data: {} });
  });

  it('returns 1404 for an unknown action', async () => {
    const registry = createActionRegistry();
    const response = await registry.handle(
      { action: 'does_not_exist', echo: 'missing-1' },
      makeContext('does_not_exist', 'missing-1'),
    );
    expect(response).toEqual({
      status: 'failed',
      retcode: 1404,
      message: 'unknown_action:does_not_exist',
      echo: 'missing-1',
    });
  });

  it('maps a thrown BridgeError to its OneBot retcode', async () => {
    const registry = createActionRegistry();
    registry.register('nope', () => {
      throw new BridgeError({ code: 'forbidden', message: 'not allowed' });
    });

    const response = await registry.handle({ action: 'nope', echo: 1 }, makeContext('nope', 1));
    expect(response.status).toBe('failed');
    expect(response.retcode).toBe(1403);
    expect(response.message).toBe('not allowed');
    expect(response.echo).toBe(1);
  });

  it('maps a thrown generic error to 1500 without leaking the message', async () => {
    const registry = createActionRegistry();
    registry.register('explode', () => {
      throw new Error('database password is hunter2');
    });

    const response = await registry.handle({ action: 'explode' }, makeContext('explode'));
    expect(response).toEqual({ status: 'failed', retcode: 1500, message: 'internal_error' });
  });

  it('reports handler failures through the optional logger without the message body', async () => {
    const warn = vi.fn();
    const registry = createActionRegistry({
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });
    registry.register('explode', () => {
      throw new BridgeError({ code: 'rate_limited', message: 'slow down' });
    });

    await registry.handle({ action: 'explode' }, makeContext('explode'));
    expect(warn).toHaveBeenCalledWith('onebot action failed', {
      action: 'explode',
      code: 'rate_limited',
    });
  });
});
