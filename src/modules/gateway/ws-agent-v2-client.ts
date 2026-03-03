import { GatewayClient } from '@/modules/gateway/ws-client';
import type { AgentV2EventEnvelope, AgentV2EventType } from '@/server/agent-v2/types';

const AGENT_V2_EVENT_TYPES: AgentV2EventType[] = [
  'agent.v2.session.updated',
  'agent.v2.command.queued',
  'agent.v2.command.started',
  'agent.v2.command.completed',
  'agent.v2.model.delta',
  'agent.v2.tool.started',
  'agent.v2.tool.completed',
  'agent.v2.approval.required',
  'agent.v2.session.completed',
  'agent.v2.error',
];

export type AgentV2EventHandler = (event: AgentV2EventEnvelope) => void;

function isTransientSocketError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    /websocket not connected/i.test(message) ||
    /client disconnected/i.test(message) ||
    /failed to connect/i.test(message)
  );
}

function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    if (String((error as { code?: unknown }).code || '') === 'RATE_LIMITED') return true;
  }
  const message = error instanceof Error ? error.message : String(error || '');
  return /too many requests/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentV2GatewayClient {
  private readonly client: GatewayClient;
  private readonly lastSeqBySession = new Map<string, number>();
  private readonly handlers = new Set<AgentV2EventHandler>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(url?: string) {
    const base = url || deriveBaseUrl();
    this.client = new GatewayClient({ protocol: 'v2', url: base });
    this.bindEventBridge();
  }

  connect(): void {
    this.client.connect();
  }

  disconnect(): void {
    this.unsubscribers.forEach((unsub) => unsub());
    this.unsubscribers.length = 0;
    this.client.disconnect();
  }

  onEvent(handler: AgentV2EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async startSession(title?: string): Promise<Record<string, unknown>> {
    return await this.client.request<Record<string, unknown>>('agent.v2.session.start', { title });
  }

  async startSessionWithOptions(input: {
    title?: string;
    personaId?: string;
    conversationId?: string;
  }): Promise<Record<string, unknown>> {
    return await this.client.request<Record<string, unknown>>('agent.v2.session.start', input);
  }

  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    return await this.client.request<Record<string, unknown>>('agent.v2.session.get', {
      sessionId,
    });
  }

  async replaySession(
    sessionId: string,
    fromSeq: number,
    limit?: number,
  ): Promise<{ events: AgentV2EventEnvelope[]; nextSeq: number }> {
    return await this.client.request<{ events: AgentV2EventEnvelope[]; nextSeq: number }>(
      'agent.v2.session.replay',
      {
        sessionId,
        fromSeq,
        limit,
      },
    );
  }

  setReplayCursor(sessionId: string, seq: number): void {
    if (!Number.isFinite(seq) || seq < 0) return;
    this.lastSeqBySession.set(sessionId, Math.floor(seq));
  }

  getReplayCursor(sessionId: string): number {
    return this.lastSeqBySession.get(sessionId) ?? 0;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const MAX_RATE_LIMIT_RETRIES = 3;
    const BASE_DELAY_MS = 1000;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        return await this.client.request(method, params);
      } catch (error) {
        // Rate-limited: retry with exponential backoff (1s, 2s, 4s)
        if (isRateLimitError(error) && attempt < MAX_RATE_LIMIT_RETRIES) {
          await sleep(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        // Transient socket error: retry once after reconnect
        if (isTransientSocketError(error) && attempt === 0) {
          this.client.connect();
          continue;
        }
        throw error;
      }
    }
    // Unreachable, but satisfies TypeScript
    throw new Error('Request failed after retries');
  }

  /**
   * Subscribe to server-push `agent.room.swarm` status events.
   * These are NOT typed AgentV2EventEnvelopes (no sessionId/seq), so they
   * bypass normalizeEnvelope and are delivered raw.
   */
  onSwarmEvent(handler: (payload: unknown) => void): () => void {
    return this.client.on('agent.room.swarm', handler);
  }

  private bindEventBridge(): void {
    for (const eventType of AGENT_V2_EVENT_TYPES) {
      const unsub = this.client.on(eventType, (payload) => {
        void this.handleIncomingEvent(payload);
      });
      this.unsubscribers.push(unsub);
    }
  }

  private async handleIncomingEvent(payload: unknown): Promise<void> {
    const envelope = normalizeEnvelope(payload);
    if (!envelope) return;

    const lastSeq = this.lastSeqBySession.get(envelope.sessionId) ?? 0;
    if (lastSeq > 0 && envelope.seq > lastSeq + 1) {
      try {
        const replay = ((await this.request('agent.v2.session.replay', {
          sessionId: envelope.sessionId,
          fromSeq: lastSeq,
        })) || { events: [] }) as { events: AgentV2EventEnvelope[] };
        for (const event of replay.events) {
          this.lastSeqBySession.set(event.sessionId, event.seq);
          this.emit(event);
        }
      } catch {
        // Replay failed — silently drop; next event will retry
      }
    }

    this.lastSeqBySession.set(envelope.sessionId, envelope.seq);
    this.emit(envelope);
  }

  private emit(event: AgentV2EventEnvelope): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

function deriveBaseUrl(): string {
  if (typeof window === 'undefined') {
    return 'ws://localhost:3000/ws?protocol=v2';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?protocol=v2`;
}

function normalizeEnvelope(payload: unknown): AgentV2EventEnvelope | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as Partial<AgentV2EventEnvelope>;
  if (
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.seq !== 'number' ||
    typeof candidate.type !== 'string'
  ) {
    return null;
  }
  return candidate as AgentV2EventEnvelope;
}
