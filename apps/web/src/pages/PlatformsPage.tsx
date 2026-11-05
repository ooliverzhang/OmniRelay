import { Link } from 'react-router-dom';

import type { Platform, PlatformCredentialView } from '../api/types';
import { usePlatformAction, usePlatforms, useUpdatePlatform } from '../api/hooks';
import { Button } from '../components/Button';
import { CapabilityMatrix } from '../components/CapabilityMatrix';
import { PageHeader } from '../components/Card';
import { CredentialSummary } from '../components/CredentialSummary';
import { EmptyState, ErrorState, LoadingBlock } from '../components/EmptyState';
import { Toggle } from '../components/Field';
import { Badge, StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { errorMessage, formatRelative } from '../lib/format';

/**
 * Lists the credentials that still need attention, keeping the list page free
 * of masked values (those are only shown on the detail page).
 */
function pendingCredentials(credentials: PlatformCredentialView[]): PlatformCredentialView[] {
  return credentials.filter((credential) => credential.state !== 'configured');
}

/** Any credential that is not `configured` raises the same badge, tinted by severity. */
function badgeTone(credentials: PlatformCredentialView[]): 'warning' | 'danger' {
  return credentials.some((credential) => credential.state === 'invalid') ? 'danger' : 'warning';
}

export function PlatformsPage() {
  const platformsQuery = usePlatforms();
  const updatePlatform = useUpdatePlatform();
  const testAction = usePlatformAction('test');
  const reconnectAction = usePlatformAction('reconnect');
  const toast = useToast();

  const items = platformsQuery.data?.items ?? [];
  const updatingPlatform = updatePlatform.isPending
    ? updatePlatform.variables?.platform
    : undefined;
  const testingPlatform = testAction.isPending ? testAction.variables : undefined;
  const reconnectingPlatform = reconnectAction.isPending ? reconnectAction.variables : undefined;

  const handleToggle = (platform: Platform, enabled: boolean) => {
    updatePlatform.mutate(
      { platform, body: { enabled } },
      {
        onSuccess: (view) => {
          toast.success(`${view.label} 已${view.enabled ? '启用' : '停用'}`);
        },
        onError: (error) => {
          toast.error(errorMessage(error, '更新平台状态失败'));
        },
      },
    );
  };

  const handleTest = (platform: Platform) => {
    testAction.mutate(platform, {
      onSuccess: (result) => {
        if (result.ok) toast.success(result.message || '连接测试通过');
        else toast.error(result.message || '连接测试未通过');
      },
      onError: (error) => toast.error(errorMessage(error, '测试连接失败')),
    });
  };

  const handleReconnect = (platform: Platform) => {
    reconnectAction.mutate(platform, {
      onSuccess: (result) => {
        if (result.ok) toast.success(result.message || '已触发重连');
        else toast.error(result.message || '重连失败');
      },
      onError: (error) => toast.error(errorMessage(error, '重连失败')),
    });
  };

  return (
    <>
      <PageHeader
        title="平台"
        description="查看各平台连接状态、凭据配置与能力矩阵"
        actions={
          <Button
            size="sm"
            onClick={() => {
              void platformsQuery.refetch();
            }}
            loading={platformsQuery.isFetching}
          >
            刷新
          </Button>
        }
      />

      {platformsQuery.isLoading ? <LoadingBlock text="正在加载平台状态…" /> : null}

      {platformsQuery.isError ? (
        <div className="surface">
          <ErrorState
            message={errorMessage(platformsQuery.error, '平台列表加载失败')}
            onRetry={() => {
              void platformsQuery.refetch();
            }}
          />
        </div>
      ) : null}

      {!platformsQuery.isLoading && !platformsQuery.isError && items.length === 0 ? (
        <div className="surface">
          <EmptyState text="暂无平台数据" />
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {items.map((item) => {
          const pending = pendingCredentials(item.credentials);
          return (
            <section key={item.platform} className="surface flex flex-col">
              <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-slate-100">{item.label}</h2>
                    <StatusBadge status={item.connection} />
                    <Badge tone={item.enabled ? 'success' : 'neutral'}>
                      {item.enabled ? '已启用' : '已停用'}
                    </Badge>
                    {pending.length > 0 ? (
                      <Link
                        to={`/platforms/${item.platform}`}
                        aria-label={`${item.label} 缺少凭据`}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium hover:brightness-125 ${
                          badgeTone(pending) === 'danger'
                            ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            badgeTone(pending) === 'danger' ? 'bg-rose-400' : 'bg-amber-400'
                          }`}
                          aria-hidden="true"
                        />
                        缺少凭据
                      </Link>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    最后事件：{formatRelative(item.lastEventAt)}
                    {item.detail ? ` · ${item.detail}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">启用</span>
                  <Toggle
                    checked={item.enabled}
                    disabled={updatingPlatform === item.platform}
                    label={`${item.label} 启用开关`}
                    onChange={(next) => handleToggle(item.platform, next)}
                  />
                </div>
              </header>

              <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5">
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    凭据状态
                  </h3>
                  <CredentialSummary pending={pending} total={item.credentials.length} />
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    能力矩阵
                  </h3>
                  <CapabilityMatrix capabilities={item.capabilities} />
                </div>
              </div>

              <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-slate-800 px-4 py-3 sm:px-5">
                <Button
                  size="sm"
                  loading={testingPlatform === item.platform}
                  disabled={updatingPlatform === item.platform}
                  onClick={() => handleTest(item.platform)}
                >
                  测试连接
                </Button>
                <Button
                  size="sm"
                  loading={reconnectingPlatform === item.platform}
                  disabled={updatingPlatform === item.platform}
                  onClick={() => handleReconnect(item.platform)}
                >
                  重连
                </Button>
                <Link
                  to={`/platforms/${item.platform}`}
                  className="ml-auto inline-flex h-8 items-center rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20"
                >
                  编辑配置
                </Link>
              </footer>
            </section>
          );
        })}
      </div>
    </>
  );
}
