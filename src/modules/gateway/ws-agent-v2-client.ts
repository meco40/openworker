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

export class AgentV2GatewayClient {
  private readonly client: GatewayClient;
  private readonly lastSeqBySession = new Map<string, number>();
  private readonly handlers = new Set<AgentV2EventHandler>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(url?: string) {
    this.client = new GatewayClient(url || deriveAgentV2Url());
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

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return await this.client.request(method, params);
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
        const replay = (await this.client.request<{
          events: AgentV2EventEnvelope[];
        }>('agent.v2.session.replay', {
          sessionId: envelope.sessionId,
          fromSeq: lastSeq,
        })) || { events: [] };
        for (const event of replay.events) {
          this.lastSeqBySession.set(event.sessionId, event.seq);
          this.emit(event);
        }
      } catch {
        const snapshot = await this.client.request('agent.v2.session.get', {
          sessionId: envelope.sessionId,
        });
        void snapshot;
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

function deriveAgentV2Url(): string {
  if (typeof window === 'undefined') {
    return 'ws://localhost:3000/ws-agent-v2';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws-agent-v2`;
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
