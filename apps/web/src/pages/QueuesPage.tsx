import { useState } from 'react';

import {
  useDeadLetters,
  useDeleteDeadLetter,
  useQueues,
  useRetryDeadLetter,
  useRetryQueueItem,
} from '../api/hooks';
import type { DeadLetterRow, QueueRow } from '../api/types';
import { Button } from '../components/Button';
import { PageHeader } from '../components/Card';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Select } from '../components/Field';
import { Pagination } from '../components/Pagination';
import { Badge } from '../components/StatusBadge';
import { DataTable, type Column } from '../components/Table';
import { useToast } from '../components/Toast';
import {
  DEFAULT_PAGE_SIZE,
  PLATFORM_OPTIONS,
  QUEUE_STATUS_OPTIONS,
  conversationKindLabel,
  deliveryStatusLabel,
  deliveryStatusTone,
  platformLabel,
} from '../lib/constants';
import { errorMessage, formatDateTime, truncate } from '../lib/format';

type TabKey = 'queue' | 'dead';

export function QueuesPage() {
  const toast = useToast();

  const [tab, setTab] = useState<TabKey>('queue');
  const [platformFilter, setPlatformFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [queuePage, setQueuePage] = useState(1);
  const [deadPage, setDeadPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pendingDelete, setPendingDelete] = useState<DeadLetterRow | null>(null);

  const queuesQuery = useQueues({
    status: statusFilter,
    platform: platformFilter,
    page: queuePage,
    pageSize,
  });
  const deadQuery = useDeadLetters({ platform: platformFilter, page: deadPage, pageSize });

  const retryQueueItem = useRetryQueueItem();
  const retryDeadLetter = useRetryDeadLetter();
  const deleteDeadLetter = useDeleteDeadLetter();

  const handleRetryQueue = (row: QueueRow) => {
    retryQueueItem.mutate(row.id, {
      onSuccess: (result) => {
        if (result.ok) toast.success(result.message || '已重新入队');
        else toast.error(result.message || '重试失败');
      },
      onError: (error) => toast.error(errorMessage(error, '重试失败')),
    });
  };

  const handleRetryDead = (row: DeadLetterRow) => {
    retryDeadLetter.mutate(row.id, {
      onSuccess: (result) => {
        if (result.ok) toast.success(result.message || '死信已重新入队');
        else toast.error(result.message || '重试失败');
      },
      onError: (error) => toast.error(errorMessage(error, '重试死信失败')),
    });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteDeadLetter.mutate(pendingDelete.id, {
      onSuccess: () => {
        toast.success('死信已删除');
        setPendingDelete(null);
      },
      onError: (error) => toast.error(errorMessage(error, '删除死信失败')),
    });
  };

  const queueColumns: Array<Column<QueueRow>> = [
    {
      key: 'status',
      header: '状态',
      render: (row) => (
        <Badge tone={deliveryStatusTone(row.status)}>{deliveryStatusLabel(row.status)}</Badge>
      ),
    },
    {
      key: 'platform',
      header: '平台',
      render: (row) => (
        <span className="text-xs text-slate-300">{platformLabel(row.platform)}</span>
      ),
    },
    {
      key: 'conversation',
      header: '会话',
      render: (row) => (
        <div className="min-w-0">
          <p className="text-xs text-slate-300">{conversationKindLabel(row.conversationKind)}</p>
          <p className="truncate font-mono text-[11px] text-slate-500">
            {row.conversationNativeId}
          </p>
        </div>
      ),
    },
    {
      key: 'text',
      header: '内容',
      render: (row) => (
        <span className="text-xs text-slate-400" title={row.text}>
          {truncate(row.text, 60)}
        </span>
      ),
    },
    {
      key: 'attempts',
      header: '尝试次数',
      align: 'center',
      render: (row) => (
        <span className="tabular-nums text-xs text-slate-300">
          {row.attempts} / {row.maxAttempts}
        </span>
      ),
    },
    {
      key: 'nextAttemptAt',
      header: '下次重试',
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-slate-400">
          {formatDateTime(row.nextAttemptAt)}
        </span>
      ),
    },
    {
      key: 'lastError',
      header: '最后错误',
      render: (row) =>
        row.lastErrorCode ? (
          <div className="min-w-0">
            <p className="font-mono text-[11px] text-rose-300">{row.lastErrorCode}</p>
            <p
              className="max-w-[220px] truncate text-xs text-slate-500"
              title={row.lastErrorMessage ?? ''}
            >
              {row.lastErrorMessage ?? '—'}
            </p>
          </div>
        ) : (
          <span className="text-xs text-slate-500">—</span>
        ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          loading={retryQueueItem.isPending && retryQueueItem.variables === row.id}
          onClick={() => handleRetryQueue(row)}
        >
          重试
        </Button>
      ),
    },
  ];

  const deadColumns: Array<Column<DeadLetterRow>> = [
    {
      key: 'platform',
      header: '平台',
      render: (row) => (
        <span className="text-xs text-slate-300">{platformLabel(row.platform)}</span>
      ),
    },
    {
      key: 'conversation',
      header: '会话',
      render: (row) => (
        <div className="min-w-0">
          <p className="text-xs text-slate-300">{conversationKindLabel(row.conversationKind)}</p>
          <p className="truncate font-mono text-[11px] text-slate-500">
            {row.conversationNativeId}
          </p>
        </div>
      ),
    },
    {
      key: 'reason',
      header: '失败原因',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-rose-300">{row.reasonCode}</p>
          <p className="max-w-[280px] truncate text-xs text-slate-400" title={row.reasonMessage}>
            {row.reasonMessage}
          </p>
        </div>
      ),
    },
    {
      key: 'text',
      header: '内容',
      render: (row) => (
        <span className="text-xs text-slate-400" title={row.text}>
          {truncate(row.text, 60)}
        </span>
      ),
    },
    {
      key: 'attempts',
      header: '尝试次数',
      align: 'center',
      render: (row) => <span className="tabular-nums text-xs text-slate-300">{row.attempts}</span>,
    },
    {
      key: 'failedAt',
      header: '失败时间',
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-slate-400">
          {formatDateTime(row.failedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="sm"
            loading={retryDeadLetter.isPending && retryDeadLetter.variables === row.id}
            onClick={() => handleRetryDead(row)}
          >
            重试
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-rose-300 hover:bg-rose-500/10"
            onClick={() => setPendingDelete(row)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="发送队列" description="查看待发送消息、重试队列与死信" />

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
        {(
          [
            { key: 'queue', label: '待发送 / 重试' },
            { key: 'dead', label: '死信' },
          ] as Array<{ key: TabKey; label: string }>
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              tab === item.key
                ? 'bg-indigo-500/15 text-indigo-200 ring-1 ring-inset ring-indigo-500/30'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="surface mb-4 flex flex-col gap-3 p-3 sm:flex-row sm:items-end">
        <div className="w-full sm:w-48">
          <label htmlFor="queue-platform" className="field-label">
            平台
          </label>
          <Select
            id="queue-platform"
            value={platformFilter}
            onChange={(event) => {
              setPlatformFilter(event.target.value);
              setQueuePage(1);
              setDeadPage(1);
            }}
          >
            <option value="">全部平台</option>
            {PLATFORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {tab === 'queue' ? (
          <div className="w-full sm:w-48">
            <label htmlFor="queue-status" className="field-label">
              状态
            </label>
            <Select
              id="queue-status"
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value);
                setQueuePage(1);
              }}
            >
              {QUEUE_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              if (tab === 'queue') void queuesQuery.refetch();
              else void deadQuery.refetch();
            }}
            loading={tab === 'queue' ? queuesQuery.isFetching : deadQuery.isFetching}
          >
            刷新
          </Button>
        </div>
      </div>

      {tab === 'queue' ? (
        <>
          <DataTable
            columns={queueColumns}
            rows={queuesQuery.data?.items}
            rowKey={(row) => row.id}
            loading={queuesQuery.isLoading}
            error={queuesQuery.isError ? errorMessage(queuesQuery.error, '队列加载失败') : null}
            onRetry={() => {
              void queuesQuery.refetch();
            }}
            emptyText="暂无待发送消息"
            minWidthClassName="min-w-[1080px]"
          />
          <Pagination
            page={queuePage}
            pageSize={pageSize}
            total={queuesQuery.data?.total ?? 0}
            onPageChange={setQueuePage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setQueuePage(1);
            }}
            disabled={queuesQuery.isFetching}
          />
        </>
      ) : (
        <>
          <DataTable
            columns={deadColumns}
            rows={deadQuery.data?.items}
            rowKey={(row) => row.id}
            loading={deadQuery.isLoading}
            error={deadQuery.isError ? errorMessage(deadQuery.error, '死信加载失败') : null}
            onRetry={() => {
              void deadQuery.refetch();
            }}
            emptyText="暂无死信"
            minWidthClassName="min-w-[980px]"
          />
          <Pagination
            page={deadPage}
            pageSize={pageSize}
            total={deadQuery.data?.total ?? 0}
            onPageChange={setDeadPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setDeadPage(1);
            }}
            disabled={deadQuery.isFetching}
          />
        </>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除死信"
        description={
          pendingDelete ? (
            <>
              <p>确定要删除这条死信吗？删除后无法恢复。</p>
              <p className="mt-1 break-words font-mono text-xs text-slate-500">
                {pendingDelete.reasonCode}：{pendingDelete.reasonMessage}
              </p>
            </>
          ) : undefined
        }
        confirmText="删除"
        loading={deleteDeadLetter.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
