import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformCredentialView, PlatformView } from '../api/types';
import { ToastProvider } from '../components/Toast';
import { PlatformsPage } from './PlatformsPage';

const SECRET_TOKEN = 'SECRET-TOKEN-MUST-NOT-APPEAR';

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as Response;
}

function makeCredential(
  overrides: Partial<PlatformCredentialView> & Pick<PlatformCredentialView, 'name' | 'env'>,
): PlatformCredentialView {
  return { state: 'missing', writable: true, masked: null, ...overrides };
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

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderPlatforms(queryClient: QueryClient): void {
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={['/platforms']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/platforms" element={children} />
            <Route path="/platforms/:id" element={<p>详情页占位</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );

  render(<PlatformsPage />, { wrapper });
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async () => jsonResponse(200, body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlatformsPage 凭据徽标', () => {
  it('凭据缺失时显示可点击的「缺少凭据」徽标并链接到详情页', async () => {
    stubFetch({
      items: [
        makePlatformView({
          credentials: [
            makeCredential({ name: 'Bot Token', env: 'DISCORD_BOT_TOKEN', state: 'missing' }),
          ],
        }),
      ],
    });

    renderPlatforms(makeQueryClient());

    const badge = await screen.findByRole('link', { name: 'Discord 缺少凭据' });
    expect(badge.getAttribute('href')).toBe('/platforms/discord');
  });

  it('凭据无效时徽标仍为「缺少凭据」但使用红色危险色', async () => {
    stubFetch({
      items: [
        makePlatformView({
          credentials: [
            makeCredential({ name: 'Bot Token', env: 'DISCORD_BOT_TOKEN', state: 'invalid' }),
          ],
        }),
      ],
    });

    renderPlatforms(makeQueryClient());

    const badge = await screen.findByRole('link', { name: 'Discord 缺少凭据' });
    expect(badge.className).toContain('rose');
    expect(badge.textContent).toBe('缺少凭据');
  });

  it('凭据全部配置时不再展示徽标，且列表页不渲染掩码值', async () => {
    stubFetch({
      items: [
        makePlatformView({
          credentials: [
            makeCredential({
              name: 'Bot Token',
              env: 'DISCORD_BOT_TOKEN',
              state: 'configured',
              masked: 'abcd…wxyz',
            }),
          ],
        }),
      ],
    });

    renderPlatforms(makeQueryClient());

    expect(await screen.findByText('全部 1 项凭据已配置')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Discord 缺少凭据' })).toBeNull();
    // Masked values belong to the detail page only.
    expect(screen.queryByText('abcd…wxyz')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain(SECRET_TOKEN);
  });

  it('混合状态下仅列出未配置项', async () => {
    stubFetch({
      items: [
        makePlatformView({
          label: 'Discord',
          credentials: [
            makeCredential({
              name: 'Bot Token',
              env: 'DISCORD_BOT_TOKEN',
              state: 'configured',
              masked: 'abcd…wxyz',
            }),
            makeCredential({
              name: 'Client Secret',
              env: 'DISCORD_CLIENT_SECRET',
              state: 'missing',
            }),
          ],
        }),
      ],
    });

    renderPlatforms(makeQueryClient());

    expect(await screen.findByText('1 / 2 项已配置')).toBeTruthy();
    const list = screen.getByText('1 / 2 项已配置').parentElement as HTMLElement;
    expect(within(list).getByText('Client Secret')).toBeTruthy();
    expect(within(list).queryByText('Bot Token')).toBeNull();
    expect(screen.queryByText('abcd…wxyz')).toBeNull();
  });
});
