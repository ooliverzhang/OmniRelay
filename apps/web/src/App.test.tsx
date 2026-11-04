import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from './App';

function sessionResponse(authenticated: boolean): Response {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        authenticated,
        authRequired: true,
        username: authenticated ? 'admin' : null,
        expiresAt: null,
      }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('应用路由骨架', () => {
  it('未登录访问受保护路由时跳转到 /login 并渲染登录表单', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/session')) return sessionResponse(false);
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    render(<App />);

    expect(await screen.findByText('面板密码')).toBeTruthy();
    expect(window.location.pathname).toBe('/login');
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });
});
