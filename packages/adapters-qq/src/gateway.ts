import { WebSocket } from 'ws';

import { QqGatewayOpcode, type QqGatewayPayload, type QqReadyPayload } from './types.js';

export type QqGatewayState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface QqGatewayLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface QqSocketLike {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: (code: number, reason: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string): void;
  close(code?: number): void;
  readonly readyState: number;
}

export type QqSocketFactory = (url: string) => QqSocketLike;

export interface QqGatewayStatus {
  state: QqGatewayState;
  sessionId: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  connectedAt: string | null;
}

export interface QqGatewayOptions {
  /** Resolves the current access token; refreshed by the token manager. */
  getAccessToken: () => Promise<string>;
  gatewayUrl: string;
  intents: number;
  logger?: QqGatewayLogger | undefined;
  createSocket?: QqSocketFactory | undefined;
  onDispatch?: ((eventName: string, data: unknown) => void) | undefined;
  onReady?: ((payload: QqReadyPayload) => void) | undefined;
  onStateChange?: ((status: QqGatewayStatus) => void) | undefined;
  now?: (() => Date) | undefined;
  rng?: (() => number) | undefined;
  baseReconnectDelayMs?: number | undefined;
  maxReconnectDelayMs?: number | undefined;
  maxReconnectAttempts?: number | undefined;
}

const WS_OPEN = 1;
const FATAL_CLOSE_CODES = new Map<number, string>([
  [4914, 'invalid_intents'],
  [4915, 'disallowed_intents'],
  [4001, 'invalid_token'],
  [4002, 'invalid_token'],
]);

/**
 * QQ official bot Gateway client (v2).
 *
 * Handles HELLO, IDENTIFY with the AppID token, heartbeats with ACK tracking,
 * session resume and exponential reconnect backoff.
 */
export class QqGateway {
  private readonly options: QqGatewayOptions;
  private readonly logger: QqGatewayLogger | undefined;
  private socket: QqSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private status: QqGatewayStatus = {
    state: 'disconnected',
    sessionId: null,
    lastEventAt: null,
    lastError: null,
    reconnectAttempts: 0,
    connectedAt: null,
  };
  private sequence: number | null = null;
  private heartbeatAcked = true;
  private stopped = false;

  constructor(options: QqGatewayOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  getStatus(): QqGatewayStatus {
    return { ...this.status };
  }

  connect(): void {
    if (this.socket) {
      return;
    }
    this.stopped = false;
    this.open();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000);
      } catch {
        // ignored
      }
    }
    this.setState('disconnected');
  }

  /** Test hook. */
  handlePayload(payload: QqGatewayPayload): void {
    this.onPayload(payload);
  }

  /** Test hook. */
  handleClose(code: number): void {
    this.onClose(code);
  }

  private open(): void {
    this.setState(this.status.sessionId ? 'reconnecting' : 'connecting');
    const factory = this.options.createSocket;
    let socket: QqSocketLike;
    try {
      socket = factory
        ? factory(this.options.gatewayUrl)
        : (new WebSocket(this.options.gatewayUrl) as unknown as QqSocketLike);
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect('socket_create_failed');
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.logger?.debug('qq gateway socket open');
    });
    socket.on('message', (data: unknown) => {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : String(data);
      let payload: QqGatewayPayload;
      try {
        payload = JSON.parse(text) as QqGatewayPayload;
      } catch {
        this.logger?.warn('qq gateway received invalid json');
        return;
      }
      this.onPayload(payload);
    });
    socket.on('close', (code: number) => {
      this.onClose(code);
    });
    socket.on('error', (error: Error) => {
      this.reportError(error);
    });
  }

  private onPayload(payload: QqGatewayPayload): void {
    if (typeof payload.s === 'number') {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case QqGatewayOpcode.HELLO: {
        const hello = payload.d as { heartbeat_interval?: number } | undefined;
        const interval = hello?.heartbeat_interval ?? 30_000;
        this.startHeartbeat(interval);
        void this.sendIdentifyOrResume();
        break;
      }
      case QqGatewayOpcode.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;
      case QqGatewayOpcode.HEARTBEAT:
        this.sendJson({ op: QqGatewayOpcode.HEARTBEAT, d: this.sequence });
        break;
      case QqGatewayOpcode.RECONNECT:
        this.logger?.info('qq gateway requested reconnect');
        this.reconnect();
        break;
      case QqGatewayOpcode.INVALID_SESSION:
        this.logger?.warn('qq gateway invalid session');
        this.status.sessionId = null;
        this.sequence = null;
        this.reconnect(1_000 + Math.floor((this.options.rng ?? Math.random)() * 4_000));
        break;
      case QqGatewayOpcode.DISPATCH:
        this.onDispatch(payload);
        break;
      default:
        this.logger?.debug('qq gateway unhandled opcode', { op: payload.op });
        break;
    }
  }

  private async sendIdentifyOrResume(): Promise<void> {
    try {
      const token = await this.options.getAccessToken();
      if (this.status.sessionId && this.sequence !== null) {
        this.sendJson({
          op: QqGatewayOpcode.RESUME,
          d: { token: `QQBot ${token}`, session_id: this.status.sessionId, seq: this.sequence },
        });
        return;
      }
      this.sendJson({
        op: QqGatewayOpcode.IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: this.options.intents,
          shard: [0, 1],
          properties: {},
        },
      });
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect('identify_token_failed');
    }
  }

  private onDispatch(payload: QqGatewayPayload): void {
    const name = payload.t ?? 'UNKNOWN';
    this.status.lastEventAt = this.nowIso();

    if (name === 'READY') {
      const ready = payload.d as QqReadyPayload | undefined;
      this.status.sessionId = ready?.session_id ?? null;
      this.status.reconnectAttempts = 0;
      this.status.connectedAt = this.nowIso();
      this.status.lastError = null;
      this.setState('connected');
      if (ready) {
        this.options.onReady?.(ready);
      }
      return;
    }

    if (name === 'RESUMED') {
      this.status.reconnectAttempts = 0;
      this.status.connectedAt = this.nowIso();
      this.setState('connected');
      return;
    }

    try {
      this.options.onDispatch?.(name, payload.d);
    } catch (error) {
      this.reportError(error);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatAcked = true;
    const safeInterval = Math.max(5, intervalMs);
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.logger?.warn('qq gateway heartbeat not acknowledged, reconnecting');
        this.reconnect();
        return;
      }
      this.heartbeatAcked = false;
      this.sendJson({ op: QqGatewayOpcode.HEARTBEAT, d: this.sequence });
    }, safeInterval);
    const timer = this.heartbeatTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private sendJson(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.reportError(error);
    }
  }

  private onClose(code: number): void {
    this.clearHeartbeat();
    this.socket = null;
    const fatal = FATAL_CLOSE_CODES.get(code);
    if (fatal) {
      this.logger?.error('qq gateway closed with fatal code', { code, reason: fatal });
      this.status.lastError = fatal;
      this.setState('error');
      return;
    }
    if (this.stopped) {
      this.setState('disconnected');
      return;
    }
    this.logger?.warn('qq gateway closed, scheduling reconnect', { code });
    this.scheduleReconnect(`close_${code}`);
  }

  private reconnect(delayOverrideMs?: number): void {
    if (this.stopped) {
      return;
    }
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(4000);
      } catch {
        // ignored
      }
    }
    this.setState('reconnecting');
    this.scheduleReconnect('manual_reconnect', delayOverrideMs);
  }

  private scheduleReconnect(reason: string, delayOverrideMs?: number): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    const maxAttempts = this.options.maxReconnectAttempts ?? 50;
    if (this.status.reconnectAttempts >= maxAttempts) {
      this.logger?.error('qq gateway reconnect attempts exhausted', { reason });
      this.status.lastError = 'reconnect_exhausted';
      this.setState('error');
      return;
    }
    this.status.reconnectAttempts += 1;
    const delay = delayOverrideMs ?? this.computeDelay(this.status.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) {
        return;
      }
      this.open();
    }, delay);
    const timer = this.reconnectTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private computeDelay(attempt: number): number {
    const base = this.options.baseReconnectDelayMs ?? 1_000;
    const max = this.options.maxReconnectDelayMs ?? 60_000;
    const exponential = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
    const rng = this.options.rng ?? Math.random;
    return Math.floor(exponential * (0.8 + rng() * 0.4));
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: QqGatewayState): void {
    if (this.status.state === state) {
      return;
    }
    this.status.state = state;
    try {
      this.options.onStateChange?.(this.getStatus());
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.status.lastError = message.slice(0, 200);
    this.logger?.error('qq gateway error', { error: this.status.lastError });
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
