import { useState } from 'react';

import { useConversations, useMessages } from '../api/hooks';
import type { ConversationRow, MessageRow } from '../api/types';
import { Button } from '../components/Button';
import { PageHeader } from '../components/Card';
import { Select, TextInput } from '../components/Field';
import { Pagination } from '../components/Pagination';
import { Badge } from '../components/StatusBadge';
import { DataTable, type Column } from '../components/Table';
import {
  DEFAULT_PAGE_SIZE,
  PLATFORM_OPTIONS,
  conversationKindLabel,
  deliveryStatusLabel,
  deliveryStatusTone,
  platformLabel,
} from '../lib/constants';
import { errorMessage, formatDateTime, formatNumber, truncate } from '../lib/format';

function MessageViewer({
  conversation,
  onClose,
}: {
  conversation: ConversationRow;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const messagesQuery = useMessages({
    platform: conversation.platform,
    conversationNativeId: conversation.conversationNativeId,
    page,
    pageSize: 20,
  });

  const columns: Array<Column<MessageRow>> = [
    {
      key: 'createdAt',
      header: '时间',
      render: (row) => (
        <span className="whitespace-nowrap font-mono text-xs text-slate-400">
          {formatDateTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'sender',
      header: '发送者',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs text-slate-300">{row.senderDisplayName ?? '未知用户'}</p>
          <p className="truncate font-mono text-[11px] text-slate-500">{row.senderNativeId}</p>
        </div>
      ),
    },
    {
      key: 'text',
      header: '内容',
      render: (row) => (
        <span className="break-words text-xs text-slate-300" title={row.text}>
          {truncate(row.text, 160)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      align: 'center',
      render: (row) => (
        <Badge tone={deliveryStatusTone(row.status)}>{deliveryStatusLabel(row.status)}</Badge>
      ),
    },
    {
      key: 'rule',
      header: '匹配规则',
      render: (row) => (
        <span className="font-mono text-[11px] text-slate-500">{row.matchedRuleId ?? '—'}</span>
      ),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="会话消息"
        className="mt-8 w-full max-w-4xl rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-100">会话消息</h2>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {platformLabel(conversation.platform)} ·{' '}
              {conversationKindLabel(conversation.conversationKind)} ·{' '}
              <span className="font-mono">{conversation.conversationNativeId}</span>
            </p>
          </div>
          <Button size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>

        <DataTable
          columns={columns}
          rows={messagesQuery.data?.items}
          rowKey={(row) => row.id}
          loading={messagesQuery.isLoading}
          error={messagesQuery.isError ? errorMessage(messagesQuery.error, '消息加载失败') : null}
          onRetry={() => {
            void messagesQuery.refetch();
          }}
          emptyText="该会话暂无消息"
          minWidthClassName="min-w-[640px]"
        />

        <Pagination
          page={page}
          pageSize={20}
          total={messagesQuery.data?.total ?? 0}
          onPageChange={setPage}
          disabled={messagesQuery.isFetching}
        />
      </div>
    </div>
  );
}

export function ConversationsPage() {
  const [platformFilter, setPlatformFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selected, setSelected] = useState<ConversationRow | null>(null);

  const query = useConversations({ platform: platformFilter, search, page, pageSize });
  const data = query.data;

  const columns: Array<Column<ConversationRow>> = [
    {
      key: 'platform',
      header: '平台',
      render: (row) => <Badge tone="info">{platformLabel(row.platform)}</Badge>,
    },
    {
      key: 'kind',
      header: '会话类型',
      render: (row) => (
        <span className="text-xs text-slate-300">
          {conversationKindLabel(row.conversationKind)}
        </span>
      ),
    },
    {
      key: 'nativeId',
      header: '会话 ID',
      render: (row) => (
        <span className="font-mono text-xs text-slate-400">{row.conversationNativeId}</span>
      ),
    },
    {
      key: 'displayName',
      header: '显示名',
      render: (row) => <span className="text-slate-300">{row.displayName ?? '—'}</span>,
    },
    {
      key: 'onebotGroupId',
      header: 'OneBot group_id',
      align: 'right',
      render: (row) => (
        <span className="font-mono text-xs text-slate-400">
          {row.onebotGroupId === null ? '—' : formatNumber(row.onebotGroupId)}
        </span>
      ),
    },
    {
      key: 'messageCount',
      header: '消息数',
      align: 'right',
      render: (row) => (
        <span className="tabular-nums text-slate-300">{formatNumber(row.messageCount)}</span>
      ),
    },
    {
      key: 'lastMessageAt',
      header: '最后消息时间',
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-slate-400">
          {formatDateTime(row.lastMessageAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (row) => (
        <Button size="sm" onClick={() => setSelected(row)}>
          查看消息
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="会话" description="按平台与会话维度查看最近的会话记录" />

      <div className="surface mb-4 flex flex-col gap-3 p-3 sm:flex-row sm:items-end">
        <div className="w-full sm:w-48">
          <label htmlFor="conversation-platform" className="field-label">
            平台
          </label>
          <Select
            id="conversation-platform"
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
            <label htmlFor="conversation-search" className="field-label">
              搜索
            </label>
            <TextInput
              id="conversation-search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="按会话 ID / 显示名搜索"
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
        rowKey={(row) => `${row.platform}:${row.conversationKind}:${row.conversationNativeId}`}
        loading={query.isLoading}
        error={query.isError ? errorMessage(query.error, '会话列表加载失败') : null}
        onRetry={() => {
          void query.refetch();
        }}
        emptyText="暂无会话数据"
        minWidthClassName="min-w-[980px]"
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

      {selected ? (
        <MessageViewer
          conversation={selected}
          onClose={() => {
            setSelected(null);
          }}
        />
      ) : null}
    </>
  );
}
