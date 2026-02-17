import { OPENAI_WORKER_EVENT_SCHEMA_VERSION } from './eventSchemaVersion';

export type OpenAiWorkerEventType =
  | 'task.started'
  | 'task.progress'
  | 'task.approval_required'
  | 'task.completed'
  | 'task.failed'
  | 'subagent.started'
  | 'subagent.progress'
  | 'subagent.completed'
  | 'subagent.failed';

export type OpenAiWorkerApplyResult = 'applied' | 'duplicate' | 'rejected_out_of_order';

export interface OpenAiWorkerEventEnvelope {
  schemaVersion: number;
  eventId: string;
  runId: string;
  taskId: string;
  type: OpenAiWorkerEventType;
  seq: number;
  emittedAt: string;
  attempt: number;
  signature: string;
  keyId: string;
  data?: Record<string, unknown>;
}

export interface OpenAiWorkerEventValidationResult {
  ok: true;
  event: OpenAiWorkerEventEnvelope;
}

export interface OpenAiWorkerEventValidationError {
  ok: false;
  error: string;
}

export type OpenAiWorkerEventValidation =
  | OpenAiWorkerEventValidationResult
  | OpenAiWorkerEventValidationError;

export function buildDefaultOpenAiWorkerEventEnvelope(
  init: Omit<OpenAiWorkerEventEnvelope, 'schemaVersion'>,
): OpenAiWorkerEventEnvelope {
  return {
    schemaVersion: OPENAI_WORKER_EVENT_SCHEMA_VERSION,
    ...init,
  };
}
