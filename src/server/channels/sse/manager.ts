// ─── SSE Connection Manager ──────────────────────────────────
// Manages Server-Sent Events connections for real-time message push.

interface SSEEvent {
  type: string;
  data: unknown;
}

interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  userId: string;
  closed: boolean;
}

class SSEManager {
  private clients: SSEClient[] = [];

  addClient(controller: ReadableStreamDefaultController, userId: string): string {
    const id = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.clients.push({ id, controller, userId, closed: false });
    return id;
  }

  removeClient(id: string): void {
    this.clients = this.clients.filter((c) => c.id !== id);
  }

  broadcast(event: SSEEvent, targetUserId?: string): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(payload);

    const toRemove: string[] = [];
    for (const client of this.clients) {
      if (client.closed) {
        toRemove.push(client.id);
        continue;
      }
      if (targetUserId && client.userId !== targetUserId) {
        continue;
      }
      try {
        client.controller.enqueue(bytes);
      } catch {
        client.closed = true;
        toRemove.push(client.id);
      }
    }
    for (const id of toRemove) {
      this.removeClient(id);
    }
  }

  get connectionCount(): number {
    return this.clients.filter((c) => !c.closed).length;
  }
}

// ─── Singleton ───────────────────────────────────────────────

declare global {
  var __sseManager: SSEManager | undefined;
}

export function getSSEManager(): SSEManager {
  if (!globalThis.__sseManager) {
    globalThis.__sseManager = new SSEManager();
  }
  return globalThis.__sseManager;
}
