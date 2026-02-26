import type { GatewayResponse } from '@/server/model-hub/Models/types';
import { stripThinkingBlocks } from '../utils';
import type { ChatResponseJson } from '../types';

interface ToolCallMapping {
  name: string;
  args?: unknown;
}

function mapToolCalls(
  toolCalls:
    | Array<{
        type?: string;
        function?: { name?: string; arguments?: unknown };
      }>
    | undefined,
): ToolCallMapping[] {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls
    .map((toolCall) => {
      const name = toolCall?.function?.name?.trim();
      if (!name) return null;

      const rawArgs = toolCall.function?.arguments;
      if (typeof rawArgs === 'string') {
        try {
          return { name, args: JSON.parse(rawArgs) };
        } catch {
          return { name, args: { raw: rawArgs } };
        }
      }
      if (rawArgs && typeof rawArgs === 'object') {
        return { name, args: rawArgs };
      }
      return { name };
    })
    .filter((call): call is ToolCallMapping => Boolean(call));
}

function mapLegacyFunctionCall(
  functionCall: { name?: string; arguments?: unknown } | undefined,
): ToolCallMapping | null {
  if (!functionCall?.name) return null;

  const name = functionCall.name.trim();
  if (!name) return null;

  const rawArgs = functionCall.arguments;
  if (typeof rawArgs === 'string') {
    try {
      return { name, args: JSON.parse(rawArgs) };
    } catch {
      return { name, args: { raw: rawArgs } };
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    return { name, args: rawArgs };
  }
  return { name };
}

function mapUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): GatewayResponse['usage'] | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

export function parseChatResponse(
  json: ChatResponseJson,
  requestModel: string,
  providerId: string,
): GatewayResponse {
  let text = json.choices?.[0]?.message?.content ?? '';
  text = stripThinkingBlocks(text);

  const message = json.choices?.[0]?.message;
  let mappedToolCalls: ToolCallMapping[] = [];

  if (message?.tool_calls) {
    mappedToolCalls = mapToolCalls(message.tool_calls);
  }

  if (mappedToolCalls.length === 0 && message?.function_call?.name) {
    const legacyCall = mapLegacyFunctionCall(message.function_call);
    if (legacyCall) {
      mappedToolCalls.push(legacyCall);
    }
  }

  return {
    ok: true,
    text,
    model: json.model ?? requestModel,
    provider: providerId,
    functionCalls: mappedToolCalls.length > 0 ? mappedToolCalls : undefined,
    usage: mapUsage(json.usage),
  };
}
