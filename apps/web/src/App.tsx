import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { UnauthorizedError } from './api/client';
import { queryKeys } from './api/hooks';
import type { SessionView } from './api/types';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ToastProvider } from './components/Toast';
import { ConversationsPage } from './pages/ConversationsPage';
import { DashboardPage } from './pages/DashboardPage';
import { IdentitiesPage } from './pages/IdentitiesPage';
import { LoginPage } from './pages/LoginPage';
import { LogsPage } from './pages/LogsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlatformDetailPage } from './pages/PlatformDetailPage';
import { PlatformsPage } from './pages/PlatformsPage';
import { QueuesPage } from './pages/QueuesPage';
import { RuleEditorPage } from './pages/RuleEditorPage';
import { RulesPage } from './pages/RulesPage';
import { SettingsPage } from './pages/SettingsPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof UnauthorizedError) return false;
        return failureCount < 1;
      },
    },
  },
});

/** Sends the user back to `/login` as soon as any query reports an expired session. */
function AuthWatcher() {
  const navigate = useNavigate();
  const client = useQueryClient();

  useEffect(() => {
    return client.getQueryCache().subscribe((event) => {
      const error = event.query.state.error;
      if (!(error instanceof UnauthorizedError)) return;
      if (event.query.queryKey[0] === 'session') return;
      client.setQueryData<SessionView>(queryKeys.session, {
        authenticated: false,
        authRequired: true,
        username: null,
        expiresAt: null,
      });
      navigate('/login', { replace: true });
    });
  }, [client, navigate]);

  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthWatcher />
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/platforms" element={<PlatformsPage />} />
                <Route path="/platforms/:id" element={<PlatformDetailPage />} />
                <Route path="/rules" element={<RulesPage />} />
                <Route path="/rules/new" element={<RuleEditorPage />} />
                <Route path="/rules/:id/edit" element={<RuleEditorPage />} />
                <Route path="/conversations" element={<ConversationsPage />} />
                <Route path="/identities" element={<IdentitiesPage />} />
                <Route path="/queues" element={<QueuesPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Route>
          </Routes>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
