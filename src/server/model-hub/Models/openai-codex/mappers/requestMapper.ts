import type { GatewayRequest } from '@/server/model-hub/Models/types';
import { DEFAULT_CODEX_INSTRUCTIONS } from '../constants';
import type { CodexReasoningEffort } from '../types';
import { clampCodexReasoningEffort } from '../client/config';
import { buildCodexInputMessages } from './messageMapper';
import { mapCodexTools } from './toolMapper';

export function buildCodexRequestBody(request: GatewayRequest): Record<string, unknown> {
  const systemParts = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);
  const instructions =
    request.systemInstruction?.trim() ||
    (systemParts.length > 0 ? systemParts.join('\n\n') : DEFAULT_CODEX_INSTRUCTIONS);

  const body: Record<string, unknown> = {
    model: request.model,
    store: false,
    stream: true,
    input: buildCodexInputMessages(request.messages),
    text: { verbosity: 'medium' },
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
