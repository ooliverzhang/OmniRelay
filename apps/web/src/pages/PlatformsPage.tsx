import { Link } from 'react-router-dom';

import type { Platform } from '../api/types';
import { usePlatformAction, usePlatforms, useUpdatePlatform } from '../api/hooks';
import { Button } from '../components/Button';
import { CapabilityMatrix, CredentialList } from '../components/CapabilityMatrix';
import { PageHeader } from '../components/Card';
import { EmptyState, ErrorState, LoadingBlock } from '../components/EmptyState';
import { Toggle } from '../components/Field';
import { Badge, StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { errorMessage, formatRelative } from '../lib/format';

export function PlatformsPage() {
  const platformsQuery = usePlatforms();
  const updatePlatform = useUpdatePlatform();
  const testAction = usePlatformAction('test');
  const reconnectAction = usePlatformAction('reconnect');
  const toast = useToast();

  const items = platformsQuery.data?.items ?? [];
  const updatingPlatform = updatePlatform.isPending ? updatePlatform.variables?.platform : undefined;
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
        {items.map((item) => (
          <section key={item.platform} className="surface flex flex-col">
            <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-slate-100">{item.label}</h2>
                  <StatusBadge status={item.connection} />
                  <Badge tone={item.enabled ? 'success' : 'neutral'}>
                    {item.enabled ? '已启用' : '已停用'}
                  </Badge>
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
                <CredentialList credentials={item.credentials} />
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
        ))}
      </div>
    </>
  );
}
