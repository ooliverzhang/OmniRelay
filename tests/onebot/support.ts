import { WebSocket } from 'ws';

import { createActionRegistry, createOneBotServer } from '@omni-relay/onebot';
import type { ActionRegistry, OneBotServer, OneBotServerOptions } from '@omni-relay/onebot';

/** Fake credential only; never a real token. */
export const TEST_TOKEN = 'test-token';
export const TEST_PATH = '/onebot';
export const TEST_SELF_ID = 10001;

export interface RunningServer {
  server: OneBotServer;
  registry: ActionRegistry;
  port: number;
}

/** Starts a server on an ephemeral port with test-friendly defaults. */
export async function startServer(
  overrides: Partial<OneBotServerOptions> = {},
): Promise<RunningServer> {
  const registry = overrides.registry ?? createActionRegistry();
  const server = createOneBotServer({
    host: '127.0.0.1',
    port: 0,
    websocketPath: TEST_PATH,
    accessToken: TEST_TOKEN,
    actionTimeoutMs: 2000,
    maxPendingActions: 16,
    heartbeatIntervalSeconds: 0,
    getSelfId: () => TEST_SELF_ID,
    registry,
    ...overrides,
  });
  const { port } = await server.start();
  return { server, registry, port };
}

export interface TestClient {
  ws: WebSocket;
  /** Messages received but not yet consumed by `waitFor`. */
  messages: unknown[];
  send(payload: unknown): void;
  waitFor<T = any>(predicate: (message: any) => boolean, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
}

interface Waiter {
  predicate: (message: any) => boolean;
  resolve: (message: any) => void;
  timer: NodeJS.Timeout;
}

/** Wraps a connected socket with a queued `waitFor` matcher. */
export function createTestClient(ws: WebSocket): TestClient {
  const messages: unknown[] = [];
  const waiters: Waiter[] = [];

  ws.on('message', (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.predicate(parsed));
    if (index === -1) {
      messages.push(parsed);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    if (waiter === undefined) {
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(parsed);
  });

  function waitFor<T = any>(predicate: (message: any) => boolean, timeoutMs = 3000): Promise<T> {
    const existingIndex = messages.findIndex((message) => predicate(message));
    if (existingIndex !== -1) {
      const [existing] = messages.splice(existingIndex, 1);
      return Promise.resolve(existing as T);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((candidate) => candidate.timer === timer);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(
          new Error(
            `timed out waiting for a matching message; buffered=${JSON.stringify(messages)}`,
          ),
        );
      }, timeoutMs);
      waiters.push({
        predicate,
        resolve: (message) => resolve(message as T),
        timer,
      });
    });
  }

  return {
    ws,
    messages,
    send(payload: unknown): void {
      ws.send(JSON.stringify(payload));
    },
    waitFor,
    close(): Promise<void> {
      if (ws.readyState === WebSocket.CLOSED) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      });
    },
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (error) => reject(error));
  });
}

export interface ConnectOptions {
  /** `null` means "no credential". */
  token?: string | null;
  source?: 'header' | 'query';
  path?: string;
}

/** Opens an authenticated client connection. */
export async function connectClient(
  port: number,
  options: ConnectOptions = {},
): Promise<TestClient> {
  const token = options.token === undefined ? TEST_TOKEN : options.token;
  const source = options.source ?? 'header';
  const path = options.path ?? TEST_PATH;
  const headers: Record<string, string> = {};
  let query = '';
  if (token !== null) {
    if (source === 'header') {
      headers.authorization = `Bearer ${token}`;
    } else {
      query = `?access_token=${encodeURIComponent(token)}`;
    }
  }
  // Listeners are attached before awaiting `open`: the server sends its
  // lifecycle event immediately, possibly in the same TCP segment as the
  // handshake response, so an `open`-then-listen order would drop it.
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`, { headers });
  const client = createTestClient(ws);
  await waitForOpen(ws);
  return client;
}

export interface RejectedUpgrade {
  statusCode: number | null;
  contentType: string | null;
  error: string | null;
}

/** Attempts an upgrade and reports the rejection without ever opening a socket. */
export function attemptUpgrade(
  url: string,
  headers?: Record<string, string>,
): Promise<RejectedUpgrade> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
    const finish = (result: RejectedUpgrade): void => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        ws.terminate();
      } catch {
        // already destroyed
      }
      resolve(result);
    };
    ws.once('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode ?? null;
      const header = response.headers['content-type'];
      const contentType = typeof header === 'string' ? header : null;
      response.resume();
      finish({ statusCode, contentType, error: null });
    });
    ws.once('error', (error) => {
      finish({ statusCode: null, contentType: null, error: error.message });
    });
    ws.once('open', () => {
      finish({ statusCode: 101, contentType: null, error: null });
    });
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitUntil(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await delay(intervalMs);
  }
  if (!check()) {
    throw new Error('condition was not met before the timeout');
  }
}
