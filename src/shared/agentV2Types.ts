export type AgentV2SchemaVersion = '2.1';

export const AGENT_V2_SCHEMA_VERSION: AgentV2SchemaVersion = '2.1';

export type AgentV2EventType =
  | 'agent.v2.session.updated'
  | 'agent.v2.command.queued'
  | 'agent.v2.command.started'
  | 'agent.v2.command.completed'
  | 'agent.v2.model.delta'
  | 'agent.v2.tool.started'
  | 'agent.v2.tool.completed'
  | 'agent.v2.approval.required'
  | 'agent.v2.session.completed'
  | 'agent.v2.error';

export interface AgentV2EventEnvelope<TPayload = Record<string, unknown>> {
  schemaVersion: AgentV2SchemaVersion;
  eventId: string;
  sessionId: string;
  commandId: string | null;
  seq: number;
  emittedAt: string;
  type: AgentV2EventType;
  payload: TPayload;
}
