import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformCredentialView, PlatformView } from '../api/types';
import { ToastProvider } from '../components/Toast';
import { PlatformDetailPage } from './PlatformDetailPage';

/** A very recognizable fake secret: it must never reach the rendered DOM. */
const PLAINTEXT_TOKEN = 'MTA5ODc2NTQzMjEwOTg3-NEVER.RENDER.THIS';

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

function makeCredential(
  overrides: Partial<PlatformCredentialView> & Pick<PlatformCredentialView, 'name' | 'env'>,
): PlatformCredentialView {
  return {
    state: 'missing',
    writable: true,
    masked: null,
    ...overrides,
  };
}

function makePlatformView(overrides: Partial<PlatformView> = {}): PlatformView {
  return {
    platform: 'discord',
    label: 'Discord',
    enabled: true,
    connection: 'connected',
    detail: null,
    lastEventAt: '2026-01-01T00:00:00.000Z',
    credentials: [],
    capabilities: {
      privateReceive: true,
      privateReply: true,
      privateProactiveSend: false,
      groupReceive: true,
      groupMentionReceive: true,
      groupReply: true,
      groupProactiveSend: false,
      broadcast: false,
    },
    settings: {
      guildAllowlist: [],
      channelAllowlist: [],
      groupAllowlist: [],
      allowProactivePrivate: false,
      allowProactiveGroup: true,
      receiveAllGroupMessages: false,
      messageContentIntent: true,
    },
    ...overrides,
  };
}

function renderDetail(queryClient: QueryClient): void {
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={['/platforms/discord']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/platforms/:id" element={children} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );

  render(<PlatformDetailPage />, { wrapper });
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Records every fetch call so tests can assert on the outgoing request. */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlatformDetailPage 凭据区域', () => {
  it('展示 masked 掩码值且页面文本不含真实 token', async () => {
    const view = makePlatformView({
      credentials: [
        makeCredential({
          name: 'Bot Token',
          env: 'DISCORD_BOT_TOKEN',
          state: 'configured',
          masked: 'MTA5…R.THIS',
        }),
      ],
    });
    stubFetch(async () => jsonResponse(200, view));

    renderDetail(makeQueryClient());

    expect(await screen.findByText('Bot Token')).toBeTruthy();
    expect(screen.getByTestId('credential-masked-DISCORD_BOT_TOKEN').textContent).toBe(
      'MTA5…R.THIS',
    );
    // The real secret is never part of the response contract nor the DOM.
    expect(document.body.textContent ?? '').not.toContain(PLAINTEXT_TOKEN);
    // Only the environment variable name is shown read-only.
    expect(screen.getByText('DISCORD_BOT_TOKEN')).toBeTruthy();
  });

  it('masked 为 null 时回退为圆点掩码', async () => {
    const view = makePlatformView({
      credentials: [
        makeCredential({
          name: 'Bot Token',
          env: 'DISCORD_BOT_TOKEN',
          state: 'configured',
          masked: null,
        }),
      ],
    });
    stubFetch(async () => jsonResponse(200, view));

    renderDetail(makeQueryClient());

    expect((await screen.findByTestId('credential-masked-DISCORD_BOT_TOKEN')).textContent).toBe(
      '••••••••',
    );
  });

  it('writable=false 时按钮被禁用并提示由运维在 .env 配置', async () => {
    const view = makePlatformView({
      credentials: [
        makeCredential({
          name: 'Bot Token',
          env: 'DISCORD_BOT_TOKEN',
          state: 'missing',
          writable: false,
        }),
      ],
    });
    stubFetch(async () => jsonResponse(200, view));

    renderDetail(makeQueryClient());

    const fillButton = await screen.findByRole('button', { name: '填写 Bot Token' });
    expect((fillButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('请由运维在服务器 .env 中配置')).toBeTruthy();
  });

  it('invalid 状态显示红色「无效」徽标与「重新填写」按钮', async () => {
    const view = makePlatformView({
      credentials: [
        makeCredential({
          name: 'Bot Token',
          env: 'DISCORD_BOT_TOKEN',
          state: 'invalid',
          masked: '••••••••',
        }),
      ],
    });
    stubFetch(async () => jsonResponse(200, view));

    renderDetail(makeQueryClient());

    expect(await screen.findByText('无效')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新填写 Bot Token' })).toBeTruthy();
  });

  it('填写 → 输入 → 提交 会弹出含 env 名的二次确认弹窗，且输入框为 password', async () => {
    const view = makePlatformView({
      credentials: [
        makeCredential({ name: 'Bot Token', env: 'DISCORD_BOT_TOKEN', state: 'missing' }),
      ],
    });
    stubFetch(async () => jsonResponse(200, view));

    renderDetail(makeQueryClient());

    fireEvent.click(await screen.findByRole('button', { name: '填写 Bot Token' }));

    const input = (await screen.findByLabelText(
      'Bot Token 值（DISCORD_BOT_TOKEN）',
    )) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('new-password');

    fireEvent.change(input, { target: { value: PLAINTEXT_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(await screen.findByText('确认写入 DISCORD_BOT_TOKEN 到 .env？')).toBeTruthy();
    expect(screen.getByText('写入后服务会重新加载该平台连接。')).toBeTruthy();
    // The confirm step must not leak the plaintext either.
    expect(document.body.textContent ?? '').not.toContain(PLAINTEXT_TOKEN);
  });

  it('确认后调用 PUT 写入、清空输入并刷新', async () => {
    const missingView = makePlatformView({
      credentials: [
        makeCredential({ name: 'Bot Token', env: 'DISCORD_BOT_TOKEN', state: 'missing' }),
      ],
    });
    const configuredView = makePlatformView({
      credentials: [
        makeCredential({
          name: 'Bot Token',
          env: 'DISCORD_BOT_TOKEN',
          state: 'configured',
          masked: 'abcd…wxyz',
        }),
      ],
    });

    let written = false;
    const fetchMock = stubFetch(async (url, init) => {
      if (url === '/api/platforms/discord/credentials' && init.method === 'PUT') {
        written = true;
        return jsonResponse(200, configuredView);
      }
      if (url === '/api/platforms/discord') {
        return jsonResponse(200, written ? configuredView : missingView);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    renderDetail(makeQueryClient());

    fireEvent.click(await screen.findByRole('button', { name: '填写 Bot Token' }));
    const input = (await screen.findByLabelText(
      'Bot Token 值（DISCORD_BOT_TOKEN）',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: PLAINTEXT_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认写入' }));

    await waitFor(() => {
      expect(screen.getByText('凭据已保存')).toBeTruthy();
    });

    const putCall = fetchMock.mock.calls.find((call) => {
      const [url, init] = call as [string, RequestInit | undefined];
      return url === '/api/platforms/discord/credentials' && init?.method === 'PUT';
    });
    expect(putCall).toBeTruthy();
    expect(JSON.parse(String((putCall?.[1] as RequestInit).body))).toEqual({
      values: { DISCORD_BOT_TOKEN: PLAINTEXT_TOKEN },
    });

    // After success the dialog is gone and the input state was cleared.
    await waitFor(() => {
      expect(screen.queryByLabelText('Bot Token 值（DISCORD_BOT_TOKEN）')).toBeNull();
    });
    expect(screen.getByTestId('credential-masked-DISCORD_BOT_TOKEN').textContent).toBe('abcd…wxyz');
  });

  it('写入失败时 Toast 展示 ApiError.message', async () => {
    const view = makePlatformView({
      credentials: [
        makeCredential({ name: 'Bot Token', env: 'DISCORD_BOT_TOKEN', state: 'missing' }),
      ],
    });
    stubFetch(async (url, init) => {
      if (url === '/api/platforms/discord/credentials' && init.method === 'PUT') {
        return errorResponse(400, 'invalid_credential_value', '凭据格式不合法');
      }
      return jsonResponse(200, view);
    });

    renderDetail(makeQueryClient());

    fireEvent.click(await screen.findByRole('button', { name: '填写 Bot Token' }));
    const input = await screen.findByLabelText('Bot Token 值（DISCORD_BOT_TOKEN）');
    fireEvent.change(input, { target: { value: 'bad-value' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认写入' }));

    expect(await screen.findByText('凭据格式不合法')).toBeTruthy();
  });

  it('credential_write_disabled 时提示控制台写入未开启', async () => {
    const view = makePlatformView({
      credentials: [
        makeCredential({ name: 'Bot Token', env: 'DISCORD_BOT_TOKEN', state: 'missing' }),
      ],
    });
    stubFetch(async (url, init) => {
      if (url === '/api/platforms/discord/credentials' && init.method === 'PUT') {
        return errorResponse(403, 'credential_write_disabled', '写入被禁用');
      }
      return jsonResponse(200, view);
    });

    renderDetail(makeQueryClient());

    fireEvent.click(await screen.findByRole('button', { name: '填写 Bot Token' }));
    const input = await screen.findByLabelText('Bot Token 值（DISCORD_BOT_TOKEN）');
    fireEvent.change(input, { target: { value: 'some-value' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认写入' }));

    expect(await screen.findByText('控制台写入未开启（allow_console_write=false）')).toBeTruthy();
  });

  it('清除已配置凭据会弹出确认并调用 DELETE', async () => {
    const configuredView = makePlatformView({
      credentials: [
        makeCredential({
          name: 'Bot Token',
          env: 'DISCORD_BOT_TOKEN',
          state: 'configured',
          masked: 'abcd…wxyz',
        }),
      ],
    });
    const clearedView = makePlatformView({
      credentials: [
        makeCredential({ name: 'Bot Token', env: 'DISCORD_BOT_TOKEN', state: 'missing' }),
      ],
    });

    let deleted = false;
    const fetchMock = stubFetch(async (url, init) => {
      if (
        url === '/api/platforms/discord/credentials/DISCORD_BOT_TOKEN' &&
        init.method === 'DELETE'
      ) {
        deleted = true;
        return jsonResponse(200, clearedView);
      }
      if (url === '/api/platforms/discord') {
        return jsonResponse(200, deleted ? clearedView : configuredView);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    renderDetail(makeQueryClient());

    fireEvent.click(await screen.findByRole('button', { name: '清除 Bot Token' }));
    expect(await screen.findByText('确认从 .env 移除 DISCORD_BOT_TOKEN？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认清除' }));

    await waitFor(() => {
      expect(screen.getByText('凭据已清除')).toBeTruthy();
    });
    expect(
      fetchMock.mock.calls.some((call) => {
        const [url, init] = call as [string, RequestInit | undefined];
        return (
          url === '/api/platforms/discord/credentials/DISCORD_BOT_TOKEN' &&
          init?.method === 'DELETE'
        );
      }),
    ).toBe(true);
  });
});
