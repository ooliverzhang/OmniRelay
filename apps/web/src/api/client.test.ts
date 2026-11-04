import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, UnauthorizedError, request } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api client', () => {
  it('成功时解析 JSON 并携带 Cookie 凭据', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, id: 'r1' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request<{ ok: boolean; id: string }>('/api/rules/r1')).resolves.toEqual({
      ok: true,
      id: 'r1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] ?? [];
    const init = call[1] as RequestInit;
    expect(call[0]).toBe('/api/rules/r1');
    expect(init.credentials).toBe('same-origin');
    expect(init.method).toBe('GET');
  });

  it('自动补全 /api 前缀并序列化 POST body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { authenticated: true }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/login', { method: 'POST', body: { password: 'secret' } });

    const call = fetchMock.mock.calls[0] ?? [];
    const init = call[1] as RequestInit;
    expect(call[0]).toBe('/api/login');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"password":"secret"}');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('401 抛出 UnauthorizedError 并保留后端消息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(401, { error: { code: 'unauthorized', message: '未登录或会话已过期' } }),
      ),
    );

    await expect(request('/api/dashboard')).rejects.toMatchObject({
      name: 'UnauthorizedError',
      code: 'unauthorized',
      message: '未登录或会话已过期',
      status: 401,
    });
  });

  it('其他错误状态解析 {error:{code,message}} 为 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(500, { error: { code: 'internal_error', message: '数据库连接失败' } }),
      ),
    );

    await expect(request('/api/rules')).rejects.toBeInstanceOf(ApiError);
    await expect(request('/api/rules')).rejects.toMatchObject({
      code: 'internal_error',
      message: '数据库连接失败',
      status: 500,
    });
  });

  it('非 JSON 错误响应使用 HTTP 兜底文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(503, '<html>bad gateway</html>')));

    await expect(request('/api/queues')).rejects.toMatchObject({
      code: 'http_503',
      message: '服务器内部错误',
      status: 503,
    });
  });

  it('404 使用对应兜底文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(404, '')));

    await expect(request('/api/rules/unknown')).rejects.toMatchObject({
      message: '请求的资源不存在',
      status: 404,
    });
  });

  it('网络异常包装为 network_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const error = await request('/api/session').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'network_error', status: 0 });
  });

  it('空响应体返回 null 而不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(204, '')));

    await expect(request('/api/logout', { method: 'POST' })).resolves.toBeNull();
  });

  it('UnauthorizedError 是 ApiError 的子类', () => {
    const error = new UnauthorizedError();
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
  });
});
