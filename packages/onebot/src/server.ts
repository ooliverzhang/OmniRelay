import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { BridgeError, isOneBotActionRequest } from '@omni-relay/shared-types';
import type {
  OneBotActionRequest,
  OneBotActionResponse,
  OneBotEvent,
  OneBotMetaEvent,
} from '@omni-relay/shared-types';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

import { verifyAccessToken } from './auth.js';
import type {
  ActionContext,
  OneBotLogger,
  OneBotServer,
  OneBotServerOptions,
  OneBotServerStatus,
} from './contracts.js';
import { toOneBotErrorResponse } from './errors.js';

/** `ws.readyState` value of an open socket. */
const OPEN_STATE = WebSocket.OPEN;

/** In-flight state of one dispatched action. */
interface PendingAction {
  action: string;
  echo: string | number | undefined;
  controller: AbortController;
  settled: boolean;
  timer?: NodeJS.Timeout | undefined;
}

interface ClientState {
  id: string;
  socket: WebSocket;
  remoteAddress: string | null;
  pending: Map<string, PendingAction>;
  closed: boolean;
}

/** Path part of a request target, without query string or fragment. */
function extractPathname(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf('?');
  const withoutQuery = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const hashIndex = withoutQuery.indexOf('#');
  return hashIndex === -1 ? withoutQuery : withoutQuery.slice(0, hashIndex);
}

/** Decodes a ws message payload into text. */
function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

/** `echo` values are limited to the OneBot 11 JSON scalar types. */
function normalizeEcho(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/** Extracts a usable `echo` from any decoded JSON value. */
function extractEcho(value: unknown): string | number | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return normalizeEcho((value as { echo?: unknown }).echo);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the OneBot 11 reverse WebSocket server.
 *
 * The server owns its own HTTP listener, authenticates upgrades, dispatches
 * actions with a per-action timeout and broadcasts events to every client.
 */
export function createOneBotServer(options: OneBotServerOptions): OneBotServer {
  const logger: OneBotLogger | undefined = options.logger;
  const websocketPath = options.websocketPath;
  const heartbeatIntervalMs = Math.round(Math.max(0, options.heartbeatIntervalSeconds) * 1000);

  const clients = new Map<WebSocket, ClientState>();
  let httpServer: HttpServer | null = null;
  let webSocketServer: WebSocketServer | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let lastEventAt: string | null = null;
  let pendingActions = 0;
  let clientSequence = 0;
  let actionSequence = 0;
  let closingPromise: Promise<void> | null = null;

  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  function createLifecycleEvent(): OneBotMetaEvent {
    return {
      time: nowSeconds(),
      self_id: options.getSelfId(),
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
    };
  }

  function createHeartbeatEvent(): OneBotMetaEvent {
    return {
      time: nowSeconds(),
      self_id: options.getSelfId(),
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      interval: heartbeatIntervalMs,
      status: { online: true, good: true },
    };
  }

  function sendJson(socket: WebSocket, payload: unknown): boolean {
    if (socket.readyState !== OPEN_STATE) {
      return false;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      logger?.error('onebot event serialisation failed', { error: describeError(error) });
      return false;
    }
    try {
      socket.send(serialized);
      return true;
    } catch (error) {
      logger?.error('onebot send failed', { error: describeError(error) });
      return false;
    }
  }

  function sendResponse(state: ClientState, response: OneBotActionResponse): void {
    if (state.closed) {
      return;
    }
    sendJson(state.socket, response);
  }

  /** Marks an action as finished; returns false when it was already settled. */
  function settleAction(state: ClientState, actionId: string, entry: PendingAction): boolean {
    entry.settled = true;
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (!state.pending.delete(actionId)) {
      return false;
    }
    pendingActions -= 1;
    return true;
  }

  function handleActionTimeout(state: ClientState, actionId: string, entry: PendingAction): void {
    if (!settleAction(state, actionId, entry)) {
      return;
    }
    const timeoutError = new BridgeError({ code: 'timeout', message: 'action_timeout' });
    entry.controller.abort(timeoutError);
    logger?.warn('onebot action timed out', {
      clientId: state.id,
      action: entry.action,
      timeoutMs: options.actionTimeoutMs,
    });
    sendResponse(state, toOneBotErrorResponse(timeoutError, entry.echo));
  }

  function cleanupClient(state: ClientState, reason: string): void {
    if (state.closed) {
      return;
    }
    state.closed = true;
    clients.delete(state.socket);
    for (const [actionId, entry] of [...state.pending.entries()]) {
      settleAction(state, actionId, entry);
      entry.controller.abort(new BridgeError({ code: 'internal', message: 'client_disconnected' }));
    }
    logger?.info('onebot client disconnected', {
      clientId: state.id,
      reason,
      clients: clients.size,
    });
  }

  async function dispatchAction(
    state: ClientState,
    action: string,
    params: Record<string, unknown> | undefined,
    echo: string | number | undefined,
  ): Promise<void> {
    actionSequence += 1;
    const actionId = `action-${actionSequence}`;
    const controller = new AbortController();
    const entry: PendingAction = { action, echo, controller, settled: false };
    state.pending.set(actionId, entry);
    pendingActions += 1;
    entry.timer = setTimeout(() => {
      handleActionTimeout(state, actionId, entry);
    }, options.actionTimeoutMs);

    const context: ActionContext = {
      action,
      echo,
      clientId: state.id,
      receivedAt: new Date(),
      remoteAddress: state.remoteAddress,
      signal: controller.signal,
    };
    const request: OneBotActionRequest = { action };
    if (params !== undefined) {
      request.params = params;
    }
    if (echo !== undefined) {
      request.echo = echo;
    }

    try {
      const response = await options.registry.handle(request, context);
      if (entry.settled) {
        logger?.debug('onebot late action response ignored', {
          clientId: state.id,
          action,
        });
        return;
      }
      sendResponse(state, response);
    } catch (error) {
      if (!entry.settled) {
        sendResponse(state, toOneBotErrorResponse(error, echo));
      }
    } finally {
      settleAction(state, actionId, entry);
    }
  }

  async function handleMessage(state: ClientState, data: RawData): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(rawDataToString(data));
    } catch {
      sendResponse(
        state,
        toOneBotErrorResponse(new BridgeError({ code: 'invalid_config', message: 'invalid_json' })),
      );
      return;
    }

    const echo = extractEcho(payload);
    if (!isOneBotActionRequest(payload)) {
      sendResponse(
        state,
        toOneBotErrorResponse(
          new BridgeError({ code: 'invalid_config', message: 'invalid_action_request' }),
          echo,
        ),
      );
      return;
    }

    if (options.maxPendingActions > 0 && pendingActions >= options.maxPendingActions) {
      logger?.warn('onebot pending action limit reached', {
        clientId: state.id,
        action: payload.action,
        limit: options.maxPendingActions,
      });
      sendResponse(
        state,
        toOneBotErrorResponse(
          new BridgeError({ code: 'rate_limited', message: 'too_many_pending_actions' }),
          echo,
        ),
      );
      return;
    }

    await dispatchAction(state, payload.action, payload.params, echo);
  }

  function onConnection(socket: WebSocket, request: IncomingMessage): void {
    clientSequence += 1;
    const state: ClientState = {
      id: `client-${clientSequence}`,
      socket,
      remoteAddress: request.socket.remoteAddress ?? null,
      pending: new Map(),
      closed: false,
    };
    clients.set(socket, state);
    logger?.info('onebot client connected', {
      clientId: state.id,
      remoteAddress: state.remoteAddress,
      clients: clients.size,
    });

    sendJson(socket, createLifecycleEvent());

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        logger?.warn('onebot binary frame ignored', { clientId: state.id });
        return;
      }
      void handleMessage(state, data).catch((error: unknown) => {
        logger?.error('onebot message handling failed', {
          clientId: state.id,
          error: describeError(error),
        });
      });
    });
    socket.on('close', () => {
      cleanupClient(state, 'socket_closed');
    });
    socket.on('error', (error: Error) => {
      logger?.error('onebot client socket error', {
        clientId: state.id,
        error: describeError(error),
      });
      cleanupClient(state, 'socket_error');
    });
  }

  function rejectUpgrade(socket: Duplex, statusLine: string, body: string): void {
    socket.on('error', () => {
      // The peer may reset the connection before reading the response.
    });
    const payload = [
      statusLine,
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n');
    socket.end(payload);
  }

  function handleUpgrade(
    wss: WebSocketServer,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const rawUrl = typeof request.url === 'string' && request.url.length > 0 ? request.url : '/';
    if (extractPathname(rawUrl) !== websocketPath) {
      rejectUpgrade(socket, 'HTTP/1.1 404 Not Found', 'Not Found');
      return;
    }

    const check = verifyAccessToken({
      authorization: request.headers.authorization,
      url: rawUrl,
      expected: options.accessToken,
    });
    if (!check.ok) {
      // Never log the credential itself, only the classification.
      logger?.warn('onebot upgrade rejected', {
        reason: check.reason,
        source: check.source,
        remoteAddress: request.socket.remoteAddress ?? null,
      });
      rejectUpgrade(socket, 'HTTP/1.1 401 Unauthorized', 'Unauthorized');
      return;
    }

    try {
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        wss.emit('connection', webSocket, request);
      });
    } catch (error) {
      logger?.error('onebot upgrade failed', { error: describeError(error) });
      socket.destroy();
    }
  }

  function broadcastEvent(event: OneBotEvent): number {
    let serialized: string;
    try {
      serialized = JSON.stringify(event);
    } catch (error) {
      logger?.error('onebot event serialisation failed', { error: describeError(error) });
      return 0;
    }

    let delivered = 0;
    for (const state of clients.values()) {
      if (state.socket.readyState !== OPEN_STATE) {
        continue;
      }
      try {
        state.socket.send(serialized);
        delivered += 1;
      } catch (error) {
        logger?.error('onebot event delivery failed', {
          clientId: state.id,
          error: describeError(error),
        });
      }
    }
    if (delivered > 0) {
      lastEventAt = new Date().toISOString();
    }
    return delivered;
  }

  function getStatus(): OneBotServerStatus {
    return {
      connected: clients.size > 0,
      clients: clients.size,
      lastEventAt,
      pendingActions,
    };
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    if (heartbeatIntervalMs <= 0) {
      return;
    }
    heartbeatTimer = setInterval(() => {
      broadcastEvent(createHeartbeatEvent());
    }, heartbeatIntervalMs);
  }

  async function start(): Promise<{ host: string; port: number }> {
    if (httpServer !== null) {
      throw new Error('onebot_server_already_started');
    }

    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('Not Found');
    });
    const wss = new WebSocketServer({ noServer: true, path: websocketPath });

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      handleUpgrade(wss, request, socket, head);
    });
    server.on('error', (error: Error) => {
      logger?.error('onebot http server error', { error: describeError(error) });
    });
    wss.on('error', (error: Error) => {
      logger?.error('onebot websocket server error', { error: describeError(error) });
    });
    wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      onConnection(socket, request);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onListenError = (error: unknown): void => {
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        server.once('error', onListenError);
        server.listen(options.port, options.host, () => {
          server.off('error', onListenError);
          resolve();
        });
      });
    } catch (error) {
      try {
        wss.close();
      } catch {
        // The failed listener has nothing to release.
      }
      logger?.error('onebot server failed to start', { error: describeError(error) });
      throw error;
    }

    httpServer = server;
    webSocketServer = wss;
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : options.port;
    startHeartbeat();
    logger?.info('onebot server listening', {
      host: options.host,
      port,
      websocketPath,
      appVersion: options.appVersion ?? null,
    });
    return { host: options.host, port };
  }

  async function doClose(): Promise<void> {
    stopHeartbeat();
    for (const state of [...clients.values()]) {
      cleanupClient(state, 'server_closing');
      try {
        state.socket.terminate();
      } catch (error) {
        logger?.error('onebot client termination failed', {
          clientId: state.id,
          error: describeError(error),
        });
      }
    }
    clients.clear();

    const wss = webSocketServer;
    webSocketServer = null;
    const server = httpServer;
    httpServer = null;

    if (wss !== null) {
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    }
    if (server !== null) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    logger?.info('onebot server closed');
  }

  function close(): Promise<void> {
    if (closingPromise === null) {
      closingPromise = doClose().finally(() => {
        closingPromise = null;
      });
    }
    return closingPromise;
  }

  return { start, close, broadcastEvent, getStatus };
}
