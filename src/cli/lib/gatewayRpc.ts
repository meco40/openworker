import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { GatewayEvents } from '../../server/gateway/events';
import { parseFrame, type EventFrame, type ResponseFrame, type StreamFrame } from '../../server/gateway/protocol';

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingStream {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  onDelta?: (delta: string) => void;
}

export interface GatewayHelloPayload {
  server?: { version?: string };
  methods?: string[];
  events?: string[];
}

export interface GatewayRpcClientOptions {
  url?: string;
  timeoutMs?: number;
}

function defaultGatewayUrl(): string {
  const configured = process.env.GATEWAY_WS_URL?.trim();
  if (configured) return configured;
  const port = Number(process.env.PORT || 3000);
  return `ws://127.0.0.1:${Number.isFinite(port) ? port : 3000}/ws`;
}

function parseTimeout(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 15_000;
}

export class GatewayRpcClient {
  private readonly socket: WebSocket;
  private readonly timeoutMs: number;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingStreams = new Map<string, PendingStream>();
  private helloPayload: GatewayHelloPayload | null = null;

  private constructor(socket: WebSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
  }

  static async connect(options: GatewayRpcClientOptions = {}): Promise<GatewayRpcClient> {
    const timeoutMs = parseTimeout(options.timeoutMs);
    const url = options.url?.trim() || defaultGatewayUrl();
    const socket = new WebSocket(url);
    const client = new GatewayRpcClient(socket, timeoutMs);

    await client.waitForOpen();
    client.attachMessageHandlers();
    await client.waitForHello();
    return client;
  }

  get hello(): GatewayHelloPayload | null {
    return this.helloPayload;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = randomUUID();

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Gateway request timeout for method "${method}".`));
      }, this.timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.send({
        type: 'req',
        id,
        method,
        params,
      });
    });
  }

  async requestStream(
    method: string,
    params: Record<string, unknown>,
    onDelta?: (delta: string) => void,
  ): Promise<void> {
    const id = randomUUID();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingStreams.delete(id);
        reject(new Error(`Gateway stream timeout for method "${method}".`));
      }, this.timeoutMs);

      this.pendingStreams.set(id, { resolve, reject, timeout, onDelta });
      this.send({
        type: 'req',
        id,
        method,
        params,
      });
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // ignore close failures
    }
  }

  private async waitForOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Could not connect to gateway websocket.'));
      }, this.timeoutMs);

      this.socket.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async waitForHello(): Promise<void> {
    if (this.helloPayload) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Gateway hello_ok event timeout.'));
      }, this.timeoutMs);

      const poll = () => {
        if (this.helloPayload) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  private attachMessageHandlers(): void {
    this.socket.on('message', (rawData) => {
      const raw = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
      const frame = parseFrame(raw);
      if (!frame) return;

      if (frame.type === 'event') {
        this.handleEvent(frame);
        return;
      }

      if (frame.type === 'res') {
        this.handleResponse(frame);
        return;
      }

      if (frame.type === 'stream') {
        this.handleStream(frame);
      }
    });

    this.socket.on('close', () => {
      this.rejectAllPending(new Error('Gateway websocket connection closed.'));
    });
    this.socket.on('error', (error) => {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private handleEvent(frame: EventFrame): void {
    if (frame.event !== GatewayEvents.HELLO_OK) return;
    if (!frame.payload || typeof frame.payload !== 'object') return;
    this.helloPayload = frame.payload as GatewayHelloPayload;
  }

  private handleResponse(frame: ResponseFrame): void {
    const id = String(frame.id);
    const pendingRequest = this.pendingRequests.get(id);
    if (pendingRequest) {
      clearTimeout(pendingRequest.timeout);
      this.pendingRequests.delete(id);
      if (!frame.ok) {
        pendingRequest.reject(new Error(frame.error?.message || 'Gateway request failed.'));
      } else {
        pendingRequest.resolve(frame.payload);
      }
      return;
    }

    const pendingStream = this.pendingStreams.get(id);
    if (!pendingStream) return;
    clearTimeout(pendingStream.timeout);
    this.pendingStreams.delete(id);
    if (!frame.ok) {
      pendingStream.reject(new Error(frame.error?.message || 'Gateway stream failed.'));
      return;
    }
    pendingStream.resolve();
  }

  private handleStream(frame: StreamFrame): void {
    const id = String(frame.id);
    const pendingStream = this.pendingStreams.get(id);
    if (!pendingStream) return;

    clearTimeout(pendingStream.timeout);
    pendingStream.timeout = setTimeout(() => {
      this.pendingStreams.delete(id);
      pendingStream.reject(new Error('Gateway stream timeout.'));
    }, this.timeoutMs);

    if (frame.delta && pendingStream.onDelta) {
      pendingStream.onDelta(frame.delta);
    }
    if (frame.done) {
      clearTimeout(pendingStream.timeout);
      this.pendingStreams.delete(id);
      pendingStream.resolve();
    }
  }

  private send(data: unknown): void {
    this.socket.send(JSON.stringify(data));
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
    for (const [id, pending] of this.pendingStreams.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingStreams.delete(id);
    }
  }
}

