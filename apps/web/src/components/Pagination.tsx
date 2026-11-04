import { PAGE_SIZE_OPTIONS } from '../lib/constants';
import { Button } from './Button';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  disabled?: boolean;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  disabled = false,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(1, page), totalPages);

  return (
    <div className="flex flex-col gap-2 px-1 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-slate-400">
        共 {total} 条 · 第 {current} / {totalPages} 页
      </p>
      <div className="flex items-center gap-2">
        {onPageSizeChange ? (
          <select
            aria-label="每页条数"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="h-8 rounded-lg border border-slate-700 bg-slate-900 px-2 text-xs text-slate-300"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} 条/页
              </option>
            ))}
          </select>
        ) : null}
        <Button size="sm" disabled={disabled || current <= 1} onClick={() => onPageChange(current - 1)}>
          上一页
        </Button>
        <Button
          size="sm"
          disabled={disabled || current >= totalPages}
          onClick={() => onPageChange(current + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
