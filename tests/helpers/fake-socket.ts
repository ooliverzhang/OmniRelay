/**
 * Minimal in-memory WebSocket double used by the adapter and integration tests.
 *
 * It implements the exact structural interface both gateways expect, so no
 * network traffic leaves the test process.
 */
export class FakeSocket {
  static instances: FakeSocket[] = [];

  static reset(): void {
    FakeSocket.instances = [];
  }

  static latest(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) {
      throw new Error('no fake socket created yet');
    }
    return socket;
  }

  /** 0 = CONNECTING, 1 = OPEN, 3 = CLOSED */
  readyState = 0;
  readonly sent: string[] = [];
  readonly url: string;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: (code: number, reason?: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: string, listener: (...args: never[]) => void): void {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, bucket);
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('socket is not open');
    }
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.emit('close', code ?? 1000);
  }

  // --- test drivers -------------------------------------------------------

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  receive(payload: unknown): void {
    this.emit('message', typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.emit('close', code);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }

  sentPayloads(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

export function createFakeSocketFactory(): (url: string) => FakeSocket {
  return (url: string) => new FakeSocket(url);
}
