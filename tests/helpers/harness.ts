import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_APP_CONFIG, type AppConfig } from '@omni-relay/shared-types';
import { openStorage, type Storage } from '@omni-relay/storage';

import type { AppLogger } from '../../apps/server/src/logger.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  formData: FormData | null;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FetchMock {
  fetch: typeof fetch;
  calls: RecordedRequest[];
  /** Requests matching a method + path fragment. */
  callsTo(fragment: string): RecordedRequest[];
}

/**
 * Deterministic `fetch` replacement that records every call.
 *
 * Handlers receive the parsed request and return a JSON (or multipart) response.
 */
export function createFetchMock(
  handler: (request: RecordedRequest) => MockResponse | Promise<MockResponse>,
): FetchMock {
  const calls: RecordedRequest[] = [];

  const mockFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const [key, value] of rawHeaders) {
        headers[key.toLowerCase()] = String(value);
      }
    } else if (rawHeaders) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key.toLowerCase()] = String(value);
      }
    }

    const bodyValue = init?.body;
    const record: RecordedRequest = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof bodyValue === 'string' ? bodyValue : null,
      formData: bodyValue instanceof FormData ? bodyValue : null,
    };
    calls.push(record);

    const response = await handler(record);
    const status = response.status ?? 200;
    const isJson = response.body !== undefined && status !== 204;
    return new Response(isJson ? JSON.stringify(response.body) : null, {
      status,
      headers: {
        'content-type': 'application/json',
        ...(response.headers ?? {}),
      },
    });
  }) as unknown as typeof fetch;

  return {
    fetch: mockFetch,
    calls,
    callsTo: (fragment: string) =>
      calls.filter((call) => `${call.method} ${call.url}`.includes(fragment)),
  };
}

export function createSilentLogger(): AppLogger & {
  records: Array<{ level: string; msg: string }>;
} {
  const records: Array<{ level: string; msg: string }> = [];
  const build = (bindings: Record<string, unknown>): AppLogger => ({
    debug: (msg) => records.push({ level: 'debug', msg }),
    info: (msg) => records.push({ level: 'info', msg }),
    warn: (msg) => records.push({ level: 'warn', msg }),
    error: (msg) => records.push({ level: 'error', msg }),
    child: (extra) => build({ ...bindings, ...extra }),
  });
  return { ...build({}), records };
}

export interface TempStorage {
  storage: Storage;
  dir: string;
  cleanup: () => void;
}

export function createTempStorage(): TempStorage {
  const dir = mkdtempSync(join(tmpdir(), 'omni-relay-test-'));
  const storage = openStorage({ sqlitePath: join(dir, 'bridge.sqlite') });
  storage.migrate();
  return {
    storage,
    dir,
    cleanup: () => {
      try {
        storage.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = structuredClone(DEFAULT_APP_CONFIG);
  const config: AppConfig = {
    ...base,
    ...overrides,
    server: {
      ...base.server,
      host: '127.0.0.1',
      onebotPort: 0,
      healthPort: 0,
      ...(overrides.server ?? {}),
    },
    web: {
      ...base.web,
      enabled: false,
      host: '127.0.0.1',
      port: 0,
      adminAuth: true,
      // Point at a directory that never exists so the SPA fallback path is
      // exercised deterministically instead of serving the real build output.
      staticDir: join(tmpdir(), 'omni-relay-test-missing-dist'),
      ...(overrides.web ?? {}),
    },
    storage: { ...base.storage, sqlitePath: ':memory:', ...(overrides.storage ?? {}) },
    logging: { ...base.logging, level: 'error', pretty: false, ...(overrides.logging ?? {}) },
    onebot: {
      ...base.onebot,
      accessTokenEnv: 'TEST_ONEBOT_TOKEN',
      actionTimeoutMs: 2_000,
      ...(overrides.onebot ?? {}),
    },
  };
  return config;
}
