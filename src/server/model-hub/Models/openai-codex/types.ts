import type { GatewayRequest } from '@/server/model-hub/Models/types';

export type CodexReasoningEffort =
  | NonNullable<GatewayRequest['reasoning_effort']>
  | 'minimal'
  | 'xhigh';

export interface CodexUsagePayload {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  input_tokens_details?: {
    cached_tokens?: unknown;
  };
}

export interface CodexResponsePayload {
  model?: unknown;
  status?: unknown;
  usage?: CodexUsagePayload;
  output?: unknown;
  error?: {
    message?: unknown;
  };
}

export interface CodexSseEvent {
  type?: unknown;
  delta?: unknown;
  arguments?: unknown;
  call_id?: unknown;
  item_id?: unknown;
  message?: unknown;
  code?: unknown;
  error?: {
    message?: unknown;
  };
  item?: unknown;
  response?: CodexResponsePayload;
}
