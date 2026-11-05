import { useState } from 'react';

import { useIdentities } from '../api/hooks';
import type { IdentityRow } from '../api/types';
import { Button } from '../components/Button';
import { PageHeader } from '../components/Card';
import { Select, TextInput } from '../components/Field';
import { Pagination } from '../components/Pagination';
import { Badge } from '../components/StatusBadge';
import { DataTable, type Column } from '../components/Table';
import { DEFAULT_PAGE_SIZE, PLATFORM_OPTIONS, platformLabel } from '../lib/constants';
import { errorMessage, formatDateTime, formatNumber } from '../lib/format';

export function IdentitiesPage() {
  const [platformFilter, setPlatformFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const query = useIdentities({ platform: platformFilter, search, page, pageSize });
  const data = query.data;

  const columns: Array<Column<IdentityRow>> = [
    {
      key: 'platform',
      header: '平台',
      render: (row) => <Badge tone="info">{platformLabel(row.platform)}</Badge>,
    },
    {
      key: 'nativeKind',
      header: '原生类型',
      render: (row) => <span className="text-xs text-slate-300">{row.nativeKind}</span>,
    },
    {
      key: 'nativeId',
      header: '原生 ID',
      render: (row) => <span className="font-mono text-xs text-slate-400">{row.nativeId}</span>,
    },
    {
      key: 'onebotKind',
      header: 'OneBot 类型',
      render: (row) => <span className="text-xs text-slate-300">{row.onebotKind}</span>,
    },
    {
      key: 'onebotId',
      header: 'OneBot ID',
      align: 'right',
      render: (row) => (
        <span className="font-mono text-xs text-slate-400">{formatNumber(row.onebotId)}</span>
      ),
    },
    {
      key: 'displayName',
      header: '显示名',
      render: (row) => <span className="text-slate-300">{row.displayName ?? '—'}</span>,
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-slate-400">
          {formatDateTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-slate-400">
          {formatDateTime(row.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="身份映射"
        description="平台原生 ID 与 OneBot ID 的映射关系（由网关自动分配）"
      />

      <div className="surface mb-4 flex flex-col gap-3 p-3 sm:flex-row sm:items-end">
        <div className="w-full sm:w-48">
          <label htmlFor="identity-platform" className="field-label">
            平台
          </label>
          <Select
            id="identity-platform"
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
            <label htmlFor="identity-search" className="field-label">
              搜索
            </label>
            <TextInput
              id="identity-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="按原生 ID / 显示名搜索"
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
        rowKey={(row) => `${row.platform}:${row.nativeKind}:${row.nativeId}`}
        loading={query.isLoading}
        error={query.isError ? errorMessage(query.error, '身份映射加载失败') : null}
        onRetry={() => {
          void query.refetch();
        }}
        emptyText="暂无身份映射"
        minWidthClassName="min-w-[900px]"
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
