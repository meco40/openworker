// ─── Gateway WebSocket Client ────────────────────────────────
// Browser-side client with reconnect, request/response correlation,
// event subscriptions, and seq-gap detection.

import type {
  EventFrame,
  RequestFrame,
  ResponseFrame,
  StreamFrame,
} from '@/server/gateway/protocol';
import type { GatewayEvent } from '@/server/gateway/events';
import type { MethodNamespace } from '@/server/gateway/method-router';

// ─── Types ───────────────────────────────────────────────────

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EventHandler = (payload: unknown, seq?: number) => void;
type StateHandler = (state: ConnectionState) => void;
type StreamHandler = (delta: string, done: boolean) => void;
export type GatewayClientRequestError = Error & { code?: string };

// ─── Constants ───────────────────────────────────────────────

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const MAX_CONNECT_FAILURES = 3; // Stop reconnecting after N failures without ever opening

function wsOpenState(): number {
  return typeof WebSocket.OPEN === 'number' ? WebSocket.OPEN : 1;
}

function wsConnectingState(): number {
  return typeof WebSocket.CONNECTING === 'number' ? WebSocket.CONNECTING : 0;
}

// ─── Client ──────────────────────────────────────────────────

export class GatewayClient {
  private ws: WebSocket | null = null;
  private _state: ConnectionState = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private stateHandlers = new Set<StateHandler>();
  private streamHandlers = new Map<string | number, StreamHandler>();
  private lastSeq = 0;
  private url: string;
  private protocol: MethodNamespace = 'v1';
  private intentionalClose = false;
  private connectFailures = 0; // Track consecutive failures without ever opening

  constructor(options?: { protocol?: MethodNamespace; url?: string } | string) {
    const url = typeof options === 'string' ? options : options?.url;
    const protocol = typeof options === 'object' ? options?.protocol : undefined;

    if (protocol) {
      this.protocol = protocol;
    }

    if (url) {
      this.url = url;
      const urlObj = new URL(url);
      const p = urlObj.searchParams.get('protocol') as MethodNamespace | null;
      if (p) this.protocol = p;
    } else if (typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.url = `${proto}//${window.location.host}/ws?protocol=${this.protocol}`;
    } else {
      this.url = `ws://localhost:3000/ws?protocol=${this.protocol}`;
    }
  }

  // ─── Public API ──────────────────────────────────────────

  get state(): ConnectionState {
    return this._state;
  }

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === wsConnectingState() || this.ws.readyState === wsOpenState())
    ) {
      return;
    }
    this.intentionalClose = false;
    this.connectFailures = 0;
    this.clearReconnectTimer();
    this.createSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    if (this.ws) {
      if (this.ws.readyState === wsConnectingState()) {
        const connectingSocket = this.ws;
        // Closing a CONNECTING socket triggers noisy browser errors in dev (StrictMode/HMR).
        // Defer the close until open and detach handlers to keep teardown quiet.
        connectingSocket.onmessage = null;
        connectingSocket.onerror = null;
        connectingSocket.onclose = null;
        connectingSocket.onopen = () => {
          try {
            connectingSocket.close(1000, 'client disconnect');
          } catch {
            // ignore
          }
        };
      } else {
        this.ws.close(1000, 'client disconnect');
      }
      this.ws = null;
    }
    this.setState('disconnected');
    this.rejectAllPending('Client disconnected');
  }

  /**
   * Send an RPC request and wait for the response.
   */
  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ensureSocketOpen();
    const ws = this.ws;
    if (!ws || ws.readyState !== wsOpenState()) {
      throw new Error('WebSocket not connected');
    }

    const id = ++this.requestId;
    const frame: RequestFrame = { type: 'req', id, method };
    if (params) frame.params = params;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (p: unknown) => void,
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error('WebSocket send failed.'));
      }
    });
  }

  async listChannels<T = unknown>(): Promise<T> {
    return this.request<T>('channels.list');
  }

  async listInbox<T = unknown>(params?: {
    channel?: string;
    q?: string;
    limit?: number;
  }): Promise<T> {
    return this.request<T>('inbox.list', params);
  }

  /**
   * Send an RPC request that returns a token stream.
   * Calls `onChunk` for each delta, resolves when done.
   */
  async requestStream(
    method: string,
    params: Record<string, unknown>,
    onChunk: (delta: string) => void,
  ): Promise<void> {
    await this.ensureSocketOpen();
    const ws = this.ws;
    if (!ws || ws.readyState !== wsOpenState()) {
      throw new Error('WebSocket not connected');
    }

    const id = ++this.requestId;
    const frame: RequestFrame = { type: 'req', id, method };
    frame.params = params;

    return new Promise<void>((resolve, reject) => {
      const armStreamIdleTimer = (): ReturnType<typeof setTimeout> =>
        setTimeout(() => {
          this.pendingRequests.delete(id);
          this.streamHandlers.delete(id);
          reject(new Error(`Stream timeout: ${method}`));
        }, STREAM_IDLE_TIMEOUT_MS);

      let timer = armStreamIdleTimer();
      const resetStreamIdleTimer = () => {
        clearTimeout(timer);
        timer = armStreamIdleTimer();
        const pending = this.pendingRequests.get(id);
        if (pending) pending.timer = timer;
      };

      this.streamHandlers.set(id, (delta: string, done: boolean) => {
        resetStreamIdleTimer();
        onChunk(delta);
        if (done) {
          clearTimeout(timer);
          this.streamHandlers.delete(id);
          this.pendingRequests.delete(id);
          resolve();
        }
      });

      this.pendingRequests.set(id, {
        resolve: () => {
          // Stream might complete via response frame if method
          // falls back to non-streaming response
          clearTimeout(timer);
          this.streamHandlers.delete(id);
          resolve();
        },
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify(frame));
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        this.streamHandlers.delete(id);
        reject(error instanceof Error ? error : new Error('WebSocket send failed.'));
      }
    });
  }

  /**
   * Subscribe to gateway events by name.
   */
  on(event: GatewayEvent | string, handler: EventHandler): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);

    // Return unsubscribe function
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.eventHandlers.delete(event);
      }
    };
  }

  /**
   * Subscribe to connection state changes.
   */
  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  // ─── Internal ────────────────────────────────────────────

  private createSocket(): void {
    this.setState('connecting');

    const ws = new WebSocket(this.url);
    this.ws = ws;
    let didOpen = false;

    ws.onopen = () => {
      didOpen = true;
      this.reconnectAttempt = 0;
      this.connectFailures = 0;
      // Wait for hello-ok event to confirm connected
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.handleMessage(ev.data as string);
    };

    ws.onerror = () => {
      // Error event is always followed by close
    };

    ws.onclose = () => {
      this.ws = null;
      if (!this.intentionalClose) {
        if (!didOpen) {
          // Socket was rejected (likely 401) — never reached open state
          this.connectFailures++;
          if (this.connectFailures >= MAX_CONNECT_FAILURES) {
            console.warn(
              '[gateway] Too many connection failures — stopping reconnect (auth issue?)',
            );
            this.setState('disconnected');
            return;
          }
        }
        this.setState('reconnecting');
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(raw: string): void {
    let frame: ResponseFrame | EventFrame | StreamFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      console.warn('[gateway] Invalid frame:', raw);
      return;
    }

    switch (frame.type) {
      case 'res': {
        const pending = this.pendingRequests.get(frame.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(frame.id);

        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          const requestError = new Error(
            frame.error?.message ?? 'Unknown error',
          ) as GatewayClientRequestError;
          requestError.code = frame.error?.code;
          pending.reject(requestError);
        }
        break;
      }

      case 'event': {
        // Track sequence gap
        if (frame.seq !== undefined) {
          if (this.lastSeq > 0 && frame.seq > this.lastSeq + 1) {
            console.warn(`[gateway] Seq gap: expected ${this.lastSeq + 1}, got ${frame.seq}`);
            // TODO: request replay of missing events
          }
          this.lastSeq = frame.seq;
        }

        // hello-ok means we're fully connected
        if (frame.event === 'hello-ok') {
          this.setState('connected');
        }

        const handlers = this.eventHandlers.get(frame.event);
        if (handlers) {
          for (const h of handlers) {
            try {
              h(frame.payload, frame.seq);
            } catch (err) {
              console.error(`[gateway] Event handler error for ${frame.event}:`, err);
            }
          }
        }
        break;
      }

      case 'stream': {
        const handler = this.streamHandlers.get(frame.id);
        if (handler) {
          handler(frame.delta, frame.done);
        }
        break;
      }
    }
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const h of this.stateHandlers) {
      try {
        h(state);
      } catch {
        // ignore
      }
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(
      DEFAULT_RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_MS,
    );
    // Add jitter
    const jitter = delay * 0.2 * Math.random();
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createSocket();
    }, delay + jitter);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async ensureSocketOpen(timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
    if (this.ws && this.ws.readyState === wsOpenState()) {
      return;
    }

    this.connect();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error('WebSocket not connected')));
      }, timeoutMs);

      const poll = setInterval(() => {
        if (this.ws && this.ws.readyState === wsOpenState()) {
          finish(resolve);
        }
      }, 50);

      const unsubscribe = this.onStateChange((state) => {
        if (state === 'connected' || (this.ws && this.ws.readyState === wsOpenState())) {
          finish(resolve);
        }
      });

      if (this.ws && this.ws.readyState === wsOpenState()) {
        finish(resolve);
      }
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
    for (const [id] of this.streamHandlers) {
      this.streamHandlers.delete(id);
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────

let instance: GatewayClient | null = null;

export function getGatewayClient(): GatewayClient {
  if (!instance) {
    instance = new GatewayClient();
  }
  return instance;
}

export function resetGatewayClient(): void {
  if (instance) {
    instance.disconnect();
    instance = null;
  }
}
