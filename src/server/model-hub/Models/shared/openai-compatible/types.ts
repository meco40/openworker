import type { GatewayRequest, GatewayResponse } from '@/server/model-hub/Models/types';

export interface StreamParseResult {
  text: string;
  model?: string;
  usage?: GatewayResponse['usage'];
  functionCalls?: Array<{ name: string; args?: unknown }>;
}

export interface SseChunk {
  model?: unknown;
  usage?: unknown;
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<{
        index?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
  }>;
}

export interface ChatResponseJson {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        type?: string;
        function?: { name?: string; arguments?: unknown };
      }>;
      function_call?: { name?: string; arguments?: unknown };
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

export interface ModelsResponseJson {
  data?: Array<{ id: string; owned_by?: string; created?: number }>;
}

export interface ErrorResponseJson {
  error?: { message?: string } | string;
}

export interface DispatchOptions {
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  onStreamDelta?: (delta: string) => void;
}

export interface BuildMessageResult {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

export type AttachmentItem = NonNullable<GatewayRequest['messages'][number]['attachments']>[number];
