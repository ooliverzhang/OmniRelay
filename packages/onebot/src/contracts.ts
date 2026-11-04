import type {
  OneBotActionRequest,
  OneBotActionResponse,
  OneBotEvent,
} from '@omni-relay/shared-types';

/**
 * Internal contract for the OneBot 11 reverse WebSocket server.
 *
 * The server owns authentication, event broadcasting, action dispatch, echo
 * correlation and timeouts. Action handlers are provided by the application.
 */

export interface OneBotLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ActionContext {
  action: string;
  echo?: string | number | undefined;
  /** Stable id of the connected OneBot client. */
  clientId: string;
  receivedAt: Date;
  remoteAddress: string | null;
  /** Aborted when the socket closes or the action times out. */
  signal: AbortSignal;
}

export interface ActionHandlerResult {
  /** `ok` by default; `async` means "accepted, delivery happens later". */
  status?: 'ok' | 'async';
  data?: unknown;
  message?: string;
}

export type ActionHandler = (
  params: Record<string, unknown>,
  context: ActionContext,
) => Promise<ActionHandlerResult> | ActionHandlerResult;

export interface ActionRegistry {
  register(action: string, handler: ActionHandler): void;
  has(action: string): boolean;
  list(): string[];
  handle(request: OneBotActionRequest, context: ActionContext): Promise<OneBotActionResponse>;
}

export interface OneBotServerStatus {
  /** True when at least one client completed the handshake. */
  connected: boolean;
  clients: number;
  lastEventAt: string | null;
  pendingActions: number;
}

export interface OneBotServerOptions {
  host: string;
  port: number;
  websocketPath: string;
  /** `null` disables token authentication (not recommended). */
  accessToken: string | null;
  actionTimeoutMs: number;
  maxPendingActions: number;
  heartbeatIntervalSeconds: number;
  registry: ActionRegistry;
  getSelfId: () => number;
  logger?: OneBotLogger | undefined;
  /** Advertised OneBot implementation version. */
  appVersion?: string | undefined;
}

export interface OneBotServer {
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** Sends an event to every connected client, returns the delivery count. */
  broadcastEvent(event: OneBotEvent): number;
  getStatus(): OneBotServerStatus;
}

/** Result of inspecting an upgrade request. */
export interface AccessTokenCheck {
  ok: boolean;
  /** Machine readable reason, e.g. `missing_credentials`. */
  reason: string | null;
  /** Sanitised credential source, never the credential itself. */
  source: 'header' | 'query' | null;
}

/** Parameters inspected during the WebSocket upgrade handshake. */
export interface AccessTokenInput {
  authorization?: string | undefined;
  url?: string | undefined;
  expected: string | null;
}
