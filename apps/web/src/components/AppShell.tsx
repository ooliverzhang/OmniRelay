import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { useLogout, useSession } from '../api/hooks';
import { errorMessage } from '../lib/format';
import { Button } from './Button';
import { useToast } from './Toast';

const ICONS = {
  dashboard: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  platforms: 'M9 3v6M15 3v6M6 9h12v2a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9zM12 17v4',
  rules: 'M4 5h16l-6 7v5l-4 2v-7L4 5z',
  conversations: 'M20 12a7.5 7.5 0 0 1-10.9 6.7L4 20l1.3-5A7.5 7.5 0 1 1 20 12z',
  identities: 'M4 6h16v12H4zM8 10h3M8 14h6',
  queues: 'M4 6h16M4 12h16M4 18h10',
  logs: 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z',
} as const;

type IconName = keyof typeof ICONS;

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: '仪表盘', icon: 'dashboard' },
  { to: '/platforms', label: '平台', icon: 'platforms' },
  { to: '/rules', label: '规则', icon: 'rules' },
  { to: '/conversations', label: '会话', icon: 'conversations' },
  { to: '/identities', label: '身份映射', icon: 'identities' },
  { to: '/queues', label: '发送队列', icon: 'queues' },
  { to: '/logs', label: '日志', icon: 'logs' },
  { to: '/settings', label: '设置', icon: 'settings' },
];

function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const session = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const toast = useToast();

  const username = session.data?.username ?? '管理员';

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        toast.success('已退出登录');
        navigate('/login', { replace: true });
      },
      onError: (error) => {
        toast.error(errorMessage(error, '退出登录失败'));
      },
    });
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-400 text-sm font-bold text-slate-950">
          OR
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-slate-100">OmniRelay</p>
          <p className="text-xs text-slate-500">全域消息中继</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                isActive
                  ? 'bg-indigo-500/15 text-indigo-200 ring-1 ring-inset ring-indigo-500/30'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`
            }
          >
            <NavIcon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-slate-800 px-5 py-3 text-xs text-slate-600">
        管理控制台 · 同源 Cookie 认证
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-950">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-800 bg-slate-900/60 backdrop-blur lg:block">
        {sidebar}
      </aside>

      {menuOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
            role="presentation"
            onClick={() => setMenuOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-slate-800 bg-slate-900 shadow-2xl">
            {sidebar}
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/85 px-4 backdrop-blur lg:px-8">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="打开导航"
              onClick={() => setMenuOpen((open) => !open)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800 text-slate-300 lg:hidden"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
              </svg>
            </button>
            <span className="text-sm font-medium text-slate-300 lg:hidden">OmniRelay</span>
            <span className="hidden text-xs text-slate-500 lg:block">全域消息中继 · 控制台</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-400 sm:inline">
              登录名：<span className="font-medium text-slate-200">{username}</span>
            </span>
            <Button size="sm" onClick={handleLogout} loading={logout.isPending}>
              退出
            </Button>
          </div>
        </header>

        <main className="px-4 pb-16 pt-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
