import type { ReactNode } from 'react';

export interface EmptyStateProps {
  text?: string;
  hint?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ text = '暂无数据', hint, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-800 bg-slate-900 text-slate-600">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
        </svg>
      </div>
      <p className="text-sm text-slate-400">{text}</p>
      {hint ? <p className="text-xs text-slate-600">{hint}</p> : null}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({ message = '加载失败', onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <p className="text-sm text-rose-300">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}

export interface LoadingBlockProps {
  text?: string;
  className?: string;
}

export function LoadingBlock({ text = '加载中…', className = '' }: LoadingBlockProps) {
  return (
    <div className={`flex items-center justify-center gap-2 px-4 py-12 text-sm text-slate-400 ${className}`}>
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400"
        aria-hidden="true"
      />
      {text}
    </div>
  );
}

export interface SkeletonProps {
  lines?: number;
  className?: string;
}

export function Skeleton({ lines = 3, className = '' }: SkeletonProps) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={`skeleton-${index}`}
          className="h-4 animate-pulse rounded bg-slate-800/70"
          style={{ width: `${100 - index * 8}%` }}
        />
      ))}
    </div>
  );
}
