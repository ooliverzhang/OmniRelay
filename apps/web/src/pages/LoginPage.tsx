import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { UnauthorizedError } from '../api/client';
import { useLogin, useSession } from '../api/hooks';
import { Button } from '../components/Button';
import { FormField, TextInput } from '../components/Field';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/format';

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const session = useSession();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const state = location.state as LocationState | null;
  const redirectTo = state?.from && state.from !== '/login' ? state.from : '/dashboard';

  const alreadyAuthenticated = session.data
    ? session.data.authenticated || !session.data.authRequired
    : false;
  if (alreadyAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!password) {
      setError('请输入密码');
      return;
    }

    login.mutate(
      { username: username.trim() || undefined, password },
      {
        onSuccess: () => {
          toast.success('登录成功');
          navigate(redirectTo, { replace: true });
        },
        onError: (mutationError) => {
          const message =
            mutationError instanceof UnauthorizedError ? '密码错误' : errorMessage(mutationError, '登录失败');
          setError(message);
          toast.error(message);
        },
      },
    );
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 px-4">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-indigo-600/20 blur-3xl" />
        <div className="absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-2xl backdrop-blur"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-emerald-400 text-sm font-bold text-slate-950">
            OR
          </div>
          <div>
            <h1 className="text-base font-semibold text-slate-100">OmniRelay</h1>
            <p className="text-xs text-slate-500">全域消息中继 · 管理控制台</p>
          </div>
        </div>

        <div className="space-y-4">
          <FormField label="用户名（可选）" htmlFor="login-username">
            <TextInput
              id="login-username"
              autoComplete="username"
              placeholder="留空则仅校验密码"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={login.isPending}
            />
          </FormField>

          <FormField label="面板密码" htmlFor="login-password" required>
            <TextInput
              id="login-password"
              type="password"
              autoComplete="current-password"
              placeholder="请输入管理员密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={login.isPending}
            />
          </FormField>

          {error ? (
            <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
            {login.isPending ? '登录中…' : '登录'}
          </Button>
        </div>

        <p className="mt-5 text-center text-xs text-slate-600">
          认证基于同源 Cookie，密码不会保存在本地
        </p>
      </form>
    </div>
  );
}
