import type { ApiErrorBody } from './types';

/**
 * Thin fetch wrapper for the OmniRelay admin API.
 *
 * Authentication is cookie based: the browser sends the session cookie because
 * every request uses `credentials: 'same-origin'`. No token is ever stored in
 * `localStorage`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = '未登录或登录已过期', code = 'unauthorized') {
    super(message, code, 401);
    this.name = 'UnauthorizedError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal | undefined;
}

async function readPayload(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  if (typeof candidate !== 'object' || candidate === null) return false;
  return typeof (candidate as { message?: unknown }).message === 'string';
}

function httpFallbackMessage(status: number): string {
  if (status === 403) return '没有权限执行该操作';
  if (status === 404) return '请求的资源不存在';
  if (status >= 500) return '服务器内部错误';
  return `请求失败（HTTP ${status}）`;
}

/** Performs a request against `/api` and resolves the parsed JSON payload. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('/api') ? path : `/api${path}`;
  const hasBody = options.body !== undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('网络请求失败，请检查连接', 'network_error', 0);
  }

  const payload = await readPayload(response);

  if (response.status === 401) {
    const message = isApiErrorBody(payload) ? payload.error.message : '未登录或登录已过期';
    const code = isApiErrorBody(payload) ? payload.error.code : 'unauthorized';
    throw new UnauthorizedError(message, code);
  }

  if (!response.ok) {
    const message = isApiErrorBody(payload) ? payload.error.message : httpFallbackMessage(response.status);
    const code = isApiErrorBody(payload) ? payload.error.code : `http_${response.status}`;
    throw new ApiError(message, code, response.status);
  }

  return payload as T;
}

export const apiClient = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
};
