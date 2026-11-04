import { ApiError } from '../api/client';

const pad = (value: number): string => String(value).padStart(2, '0');

/** `2024-05-06 07:08:09` in the browser's local timezone. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${ymd} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `05-06 07:08` — compact form used in tables and charts. */
export function formatDateTimeShort(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `07:08` — hourly bucket label for the dashboard trend chart. */
export function formatHourLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${pad(date.getHours())}:00`;
}

/** `3 分钟前` style relative time. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return '刚刚';
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 2_592_000) return `${Math.floor(seconds / 86_400)} 天前`;
  return formatDateTime(value);
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${seconds} 秒`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN');
}

export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** Splits a textarea value into a de-duplicated list (comma or newline separated). */
export function parseIdList(input: string | null | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.split(/[\s,，;；]+/u)) {
    const token = raw.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

/** Like {@link parseIdList} but keeps inner spaces so phrases stay intact. */
export function parseLineList(input: string | null | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.split(/[\n,，;；]+/u)) {
    const token = raw.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

export function joinIdList(list: readonly string[] | null | undefined): string {
  return (list ?? []).join('\n');
}

export type QueryValue = string | number | boolean | null | undefined;

/** Builds an API query string, skipping empty values. Returns `''` when empty. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

export function truncate(text: string | null | undefined, max = 80): string {
  if (!text) return '—';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Extracts a user facing message from an unknown thrown value. */
export function errorMessage(error: unknown, fallback = '操作失败'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}
