import { WebSocket } from 'ws';

import {
  DISCORD_FATAL_CLOSE_CODES,
  DiscordGatewayOpcode,
  type DiscordGatewayPayload,
  type DiscordReadyPayload,
  type DiscordUser,
} from './types.js';

export type DiscordGatewayState =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface DiscordGatewayLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Structural socket interface so the gateway can be exercised with a fake
 * socket in tests without depending on the `ws` implementation details.
 */
export interface DiscordSocketLike {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: (code: number, reason: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string): void;
  close(code?: number): void;
  readonly readyState: number;
}

export type DiscordSocketFactory = (url: string) => DiscordSocketLike;

export interface DiscordGatewayStatus {
  state: DiscordGatewayState;
  sessionId: string | null;
  userId: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  connectedAt: string | null;
}

export interface DiscordGatewayOptions {
  token: string;
  gatewayUrl: string;
  intents: number;
  logger?: DiscordGatewayLogger | undefined;
  createSocket?: DiscordSocketFactory | undefined;
  onDispatch?: ((eventName: string, data: unknown) => void) | undefined;
  onReady?: ((user: DiscordUser) => void) | undefined;
  onStateChange?: ((status: DiscordGatewayStatus) => void) | undefined;
  now?: (() => Date) | undefined;
  /** Base delay for exponential reconnect backoff (ms). */
  baseReconnectDelayMs?: number | undefined;
  maxReconnectDelayMs?: number | undefined;
  maxReconnectAttempts?: number | undefined;
  /** Random source in `[0,1)` used for jitter. */
  rng?: (() => number) | undefined;
}

const WS_OPEN = 1;

/**
 * Discord Gateway client: HELLO/IDENTIFY/RESUME, heartbeat with ACK tracking,
 * session resume and exponential backoff on transient disconnects.
 */
export class DiscordGateway {
  private readonly options: DiscordGatewayOptions;
  private readonly logger: DiscordGatewayLogger | undefined;
  private socket: DiscordSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private status: DiscordGatewayStatus = {
    state: 'disconnected',
    sessionId: null,
    userId: null,
    lastEventAt: null,
    lastError: null,
    reconnectAttempts: 0,
    connectedAt: null,
  };
  private sequence: number | null = null;
  private heartbeatAcked = true;
  private stopped = false;

  constructor(options: DiscordGatewayOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  getStatus(): DiscordGatewayStatus {
    return { ...this.status };
  }

  connect(): void {
    if (this.socket) {
      return;
    }
    this.stopped = false;
    this.open(false);
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
        // ignored: closing an already closed socket is not an error
      }
    }
    this.setState('disconnected');
  }

  /** Test hook: feeds a gateway payload as if it came from the socket. */
  handlePayload(payload: DiscordGatewayPayload): void {
    this.onPayload(payload);
  }

  /** Test hook: simulates a socket close with the given code. */
  handleClose(code: number): void {
    this.onClose(code);
  }

  private open(isResume: boolean): void {
    this.setState(isResume ? 'reconnecting' : 'connecting');
    const factory = this.options.createSocket;
    let socket: DiscordSocketLike;
    try {
      socket = factory
        ? factory(this.options.gatewayUrl)
        : createDefaultSocket(this.options.gatewayUrl);
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect('socket_create_failed');
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.logger?.debug('discord gateway socket open');
    });
    socket.on('message', (data: unknown) => {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : String(data);
      this.onRawMessage(text);
    });
    socket.on('close', (code: number) => {
      this.onClose(code);
    });
    socket.on('error', (error: Error) => {
      this.reportError(error);
    });
  }

  private onRawMessage(text: string): void {
    let payload: DiscordGatewayPayload;
    try {
      payload = JSON.parse(text) as DiscordGatewayPayload;
    } catch {
      this.logger?.warn('discord gateway received invalid json');
      return;
    }
    this.onPayload(payload);
  }

  private onPayload(payload: DiscordGatewayPayload): void {
    if (typeof payload.s === 'number') {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case DiscordGatewayOpcode.HELLO: {
        const hello = payload.d as { heartbeat_interval?: number } | undefined;
        const interval = hello?.heartbeat_interval ?? 41_250;
        this.startHeartbeat(interval);
        if (this.status.sessionId && this.sequence !== null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;
      }
      case DiscordGatewayOpcode.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;
      case DiscordGatewayOpcode.HEARTBEAT: {
        this.sendJson({ op: DiscordGatewayOpcode.HEARTBEAT, d: this.sequence });
        break;
      }
      case DiscordGatewayOpcode.RECONNECT: {
        this.logger?.info('discord gateway requested reconnect');
        this.reconnect();
        break;
      }
      case DiscordGatewayOpcode.INVALID_SESSION: {
        const resumable = payload.d === true;
        this.logger?.warn('discord gateway invalid session', { resumable });
        if (!resumable) {
          this.status.sessionId = null;
          this.sequence = null;
        }
        this.reconnect(1_000 + Math.floor((this.options.rng ?? Math.random)() * 4_000));
        break;
      }
      case DiscordGatewayOpcode.DISPATCH: {
        this.onDispatch(payload);
        break;
      }
      default:
        this.logger?.debug('discord gateway unhandled opcode', { op: payload.op });
        break;
    }
  }

  private onDispatch(payload: DiscordGatewayPayload): void {
    const name = payload.t ?? 'UNKNOWN';
    this.status.lastEventAt = this.nowIso();

    if (name === 'READY') {
      const ready = payload.d as DiscordReadyPayload | undefined;
      this.status.sessionId = ready?.session_id ?? null;
      this.status.userId = ready?.user?.id ?? null;
      this.status.reconnectAttempts = 0;
      this.status.connectedAt = this.nowIso();
      this.status.lastError = null;
      this.setState('connected');
      if (ready?.user) {
        this.options.onReady?.(ready.user);
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

  private sendIdentify(): void {
    this.sendJson({
      op: DiscordGatewayOpcode.IDENTIFY,
      d: {
        token: this.options.token,
        intents: this.options.intents,
        properties: { os: 'linux', browser: 'omni-relay', device: 'omni-relay' },
      },
    });
  }

  private sendResume(): void {
    this.sendJson({
      op: DiscordGatewayOpcode.RESUME,
      d: {
        token: this.options.token,
        session_id: this.status.sessionId,
        seq: this.sequence,
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatAcked = true;
    const safeInterval = Math.max(5, intervalMs);
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.logger?.warn('discord gateway heartbeat not acknowledged, reconnecting');
        this.reconnect();
        return;
      }
      this.heartbeatAcked = false;
      this.sendJson({ op: DiscordGatewayOpcode.HEARTBEAT, d: this.sequence });
    }, safeInterval);
    // Node keeps the process alive otherwise; the timer is unref'd on purpose.
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
    const fatalReason = DISCORD_FATAL_CLOSE_CODES[code];
    if (fatalReason) {
      this.logger?.error('discord gateway closed with fatal code', { code, reason: fatalReason });
      this.status.lastError = fatalReason;
      this.setState('error');
      return;
    }
    if (this.stopped) {
      this.setState('disconnected');
      return;
    }
    this.logger?.warn('discord gateway closed, scheduling reconnect', { code });
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
      this.logger?.error('discord gateway reconnect attempts exhausted', { reason });
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
      this.open(true);
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

  private setState(state: DiscordGatewayState): void {
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
    this.logger?.error('discord gateway error', { error: this.status.lastError });
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

function createDefaultSocket(url: string): DiscordSocketLike {
  return new WebSocket(url) as unknown as DiscordSocketLike;
}
