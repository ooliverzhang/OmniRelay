import type { ReactNode } from 'react';

import { EmptyState, ErrorState } from './EmptyState';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}

const ALIGN_CLASSES: Record<NonNullable<Column<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyText?: string;
  emptyHint?: string;
  loadingRows?: number;
  onRowClick?: (row: T) => void;
  minWidthClassName?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  emptyText = '暂无数据',
  emptyHint,
  loadingRows = 5,
  onRowClick,
  minWidthClassName = 'min-w-[720px]',
}: DataTableProps<T>) {
  const columnCount = columns.length;
  const safeRows = rows ?? [];
  const showSkeleton = loading && safeRows.length === 0;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="overflow-x-auto">
        <table className={`w-full border-collapse text-sm ${minWidthClassName}`}>
          <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`whitespace-nowrap px-4 py-2.5 font-medium ${ALIGN_CLASSES[column.align ?? 'left']}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80">
            {error ? (
              <tr>
                <td colSpan={columnCount}>
                  <ErrorState message={error} onRetry={onRetry} />
                </td>
              </tr>
            ) : showSkeleton ? (
              Array.from({ length: loadingRows }, (_, index) => (
                <tr key={`skeleton-${index}`}>
                  <td colSpan={columnCount} className="px-4 py-3">
                    <div className="h-4 w-full animate-pulse rounded bg-slate-800/70" />
                  </td>
                </tr>
              ))
            ) : safeRows.length === 0 ? (
              <tr>
                <td colSpan={columnCount}>
                  <EmptyState text={emptyText} hint={emptyHint} />
                </td>
              </tr>
            ) : (
              safeRows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={`transition ${
                    onRowClick ? 'cursor-pointer hover:bg-slate-800/40' : 'hover:bg-slate-800/20'
                  }`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`px-4 py-2.5 align-middle text-slate-300 ${ALIGN_CLASSES[column.align ?? 'left']} ${column.className ?? ''}`}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {loading && safeRows.length > 0 ? (
        <div className="border-t border-slate-800 px-4 py-1.5 text-xs text-indigo-300">加载中…</div>
      ) : null}
    </div>
  );
}
