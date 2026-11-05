import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useSession } from '../api/hooks';
import { ErrorState, LoadingBlock } from './EmptyState';

/** Blocks protected routes until the session query resolves, then redirects to `/login`. */
export function ProtectedRoute() {
  const location = useLocation();
  const session = useSession();

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <LoadingBlock text="正在校验登录状态…" />
      </div>
    );
  }

  if (session.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <ErrorState
          message="无法连接后端服务，请确认服务已启动"
          onRetry={() => {
            void session.refetch();
          }}
        />
      </div>
    );
  }

  const data = session.data;
  const authenticated = data ? data.authenticated || !data.authRequired : false;

  if (!authenticated) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }

  return <Outlet />;
}
