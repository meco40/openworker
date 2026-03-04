import WsClient, { type RawData } from 'ws';
import type {
  EventFrame,
  RequestFrame,
  ResponseFrame,
  StreamFrame,
} from '@/server/gateway/protocol';

type GatewayIncoming = ResponseFrame | EventFrame | StreamFrame;

type PendingRequest = {
  resolve: (frame: ResponseFrame) => void;
  reject: (error: Error) => void;
};

export interface WsRpcClient {
  request(method: string, params?: Record<string, unknown>): Promise<ResponseFrame>;
  stream(method: string, params?: Record<string, unknown>): Promise<StreamFrame[]>;
  close(): Promise<void>;
}

function parseIncoming(raw: RawData): GatewayIncoming | null {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    return JSON.parse(text) as GatewayIncoming;
  } catch {
    return null;
  }
}

function normalizeGatewayUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.searchParams.get('protocol') !== 'v2') {
      parsed.searchParams.set('protocol', 'v2');
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

export async function createWsRpcClient(url: string): Promise<WsRpcClient> {
  const socket = new WsClient(normalizeGatewayUrl(url));
  const pending = new Map<string | number, PendingRequest>();
  let nextId = 1;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 15_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  socket.on('message', (raw) => {
    const frame = parseIncoming(raw);
    if (!frame || frame.type !== 'res') {
      return;
    }
    const request = pending.get(frame.id);
    if (!request) {
      return;
    }
    pending.delete(frame.id);
    request.resolve(frame);
  });

  return {
    request(method: string, params?: Record<string, unknown>) {
      const id = `req-${nextId++}`;
      const frame: RequestFrame = { type: 'req', id, method, params };

      return new Promise<ResponseFrame>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify(frame), (error) => {
          if (error) {
            pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    },

    stream(method: string, params?: Record<string, unknown>) {
      const id = `req-${nextId++}`;
      const frame: RequestFrame = { type: 'req', id, method, params };

      return new Promise<StreamFrame[]>((resolve, reject) => {
        const chunks: StreamFrame[] = [];

        const onMessage = (raw: RawData) => {
          const incoming = parseIncoming(raw);
          if (!incoming || incoming.type === 'event' || incoming.id !== id) {
            return;
          }

          if (incoming.type === 'res') {
            socket.off('message', onMessage);
            if (!incoming.ok) {
              const message = incoming.error?.message || 'Stream request failed';
              reject(new Error(message));
              return;
            }
            resolve(chunks);
            return;
          }

          if (incoming.type !== 'stream') {
            return;
          }

          chunks.push(incoming);
          if (incoming.done) {
            socket.off('message', onMessage);
            resolve(chunks);
          }
        };

        socket.on('message', onMessage);
        socket.send(JSON.stringify(frame), (error) => {
          if (error) {
            socket.off('message', onMessage);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    },

    async close() {
      if (socket.readyState === WsClient.CLOSED) {
        return;
      }
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close(1000, 'test complete');
      });
    },
  };
}
