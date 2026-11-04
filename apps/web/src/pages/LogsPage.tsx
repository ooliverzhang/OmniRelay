import { useState } from 'react';

import { useLogs } from '../api/hooks';
import type { LogRow } from '../api/types';
import { Button } from '../components/Button';
import { PageHeader } from '../components/Card';
import { Select, TextInput } from '../components/Field';
import { Pagination } from '../components/Pagination';
import { Badge } from '../components/StatusBadge';
import { DataTable, type Column } from '../components/Table';
import {
  DEFAULT_PAGE_SIZE,
  LOG_LEVEL_OPTIONS,
  PLATFORM_OPTIONS,
  logLevelTone,
  platformLabel,
} from '../lib/constants';
import { errorMessage, formatDateTime } from '../lib/format';

export function LogsPage() {
  const [levelFilter, setLevelFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const query = useLogs({
    level: levelFilter,
    platform: platformFilter,
    search,
    page,
    pageSize,
  });
  const data = query.data;

  const columns: Array<Column<LogRow>> = [
    {
      key: 'time',
      header: '时间',
      render: (row) => (
        <span className="whitespace-nowrap font-mono text-xs text-slate-400">
          {formatDateTime(row.time)}
        </span>
      ),
    },
    {
      key: 'level',
      header: '级别',
      align: 'center',
      render: (row) => <Badge tone={logLevelTone(row.level)}>{row.level}</Badge>,
    },
    {
      key: 'msg',
      header: '消息',
      render: (row) => <span className="break-words text-xs text-slate-300">{row.msg}</span>,
    },
    {
      key: 'platform',
      header: '平台',
      render: (row) => (
        <span className="text-xs text-slate-400">{row.platform ? platformLabel(row.platform) : '—'}</span>
      ),
    },
    {
      key: 'event',
      header: '事件',
      render: (row) => <span className="font-mono text-[11px] text-slate-500">{row.event ?? '—'}</span>,
    },
    {
      key: 'context',
      header: '上下文',
      render: (row) =>
        row.context ? (
          <details className="group">
            <summary className="cursor-pointer text-xs text-indigo-300 hover:underline">查看</summary>
            <pre className="mt-1 max-h-40 max-w-[420px] overflow-auto rounded-md border border-slate-800 bg-slate-950/70 p-2 text-[11px] leading-relaxed text-slate-400">
              {JSON.stringify(row.context, null, 2)}
            </pre>
          </details>
        ) : (
          <span className="text-xs text-slate-600">—</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader title="日志" description="服务端结构化日志，按级别、平台与关键字筛选" />

      <div className="surface mb-4 flex flex-col gap-3 p-3 sm:flex-row sm:items-end">
        <div className="w-full sm:w-40">
          <label htmlFor="log-level" className="field-label">
            级别
          </label>
          <Select
            id="log-level"
            value={levelFilter}
            onChange={(event) => {
              setLevelFilter(event.target.value);
              setPage(1);
            }}
          >
            {LOG_LEVEL_OPTIONS.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-full sm:w-48">
          <label htmlFor="log-platform" className="field-label">
            平台
          </label>
          <Select
            id="log-platform"
            value={platformFilter}
            onChange={(event) => {
              setPlatformFilter(event.target.value);
              setPage(1);
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

        <form
          className="flex flex-1 items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
            setPage(1);
          }}
        >
          <div className="flex-1">
            <label htmlFor="log-search" className="field-label">
              关键字
            </label>
            <TextInput
              id="log-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索日志内容"
            />
          </div>
          <Button type="submit" variant="primary">
            搜索
          </Button>
          <Button
            onClick={() => {
              setSearchInput('');
              setSearch('');
              setPage(1);
            }}
          >
            重置
          </Button>
        </form>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(row) => row.id}
        loading={query.isLoading}
        error={query.isError ? errorMessage(query.error, '日志加载失败') : null}
        onRetry={() => {
          void query.refetch();
        }}
        emptyText="暂无日志"
        minWidthClassName="min-w-[1040px]"
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        disabled={query.isFetching}
      />
    </>
  );
}
