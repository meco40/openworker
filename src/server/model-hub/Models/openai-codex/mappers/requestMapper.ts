import type { GatewayRequest } from '@/server/model-hub/Models/types';
import { DEFAULT_CODEX_INSTRUCTIONS } from '../constants';
import type { CodexReasoningEffort } from '../types';
import { clampCodexReasoningEffort } from '../client/config';
import { buildCodexInputMessages } from './messageMapper';
import { mapCodexTools } from './toolMapper';

function mapResponseFormat(
  value: unknown,
  responseMimeType?: string,
): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const typed = value as {
      type?: unknown;
      json_schema?: { name?: unknown; schema?: unknown; strict?: unknown };
    };

    if (typed.type === 'json_object') {
      return { type: 'json_object' };
    }

    if (typed.type === 'json_schema' && typed.json_schema?.name && typed.json_schema.schema) {
      return {
        type: 'json_schema',
        name: String(typed.json_schema.name),
        schema: typed.json_schema.schema,
        strict: typed.json_schema.strict !== false,
      };
    }
  }

  return responseMimeType === 'application/json' ? { type: 'json_object' } : undefined;
}

export function buildCodexRequestBody(request: GatewayRequest): Record<string, unknown> {
  const systemParts = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);
  const instructions =
    request.systemInstruction?.trim() ||
    (systemParts.length > 0 ? systemParts.join('\n\n') : DEFAULT_CODEX_INSTRUCTIONS);

  const text: Record<string, unknown> = { verbosity: 'medium' };
  const responseFormat = mapResponseFormat(request.responseFormat, request.responseMimeType);
  if (responseFormat) text.format = responseFormat;

  const body: Record<string, unknown> = {
    model: request.model,
    store: false,
    stream: true,
    input: buildCodexInputMessages(request.messages),
    text,
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    instructions,
  };

  if (request.reasoning_effort) {
    body.reasoning = {
      effort: clampCodexReasoningEffort(
        request.model,
        request.reasoning_effort as CodexReasoningEffort,
      ),
      summary: 'auto',
    };
  }

  const tools = mapCodexTools(request.tools);
  if (tools.length > 0) {
    body.tools = tools;
  }

  return body;
}
