import type { GatewayResponse } from '@/server/model-hub/Models/types';
import type { CodexUsagePayload } from '../types';
import { toNonEmptyString, toNumberOrNull } from '../utils/typeGuards';

export function extractTextFromCodexOutput(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const typedItem = item as { type?: unknown; content?: unknown };
    if (typedItem.type !== 'message' || !Array.isArray(typedItem.content)) continue;
    for (const contentPart of typedItem.content) {
      if (!contentPart || typeof contentPart !== 'object') continue;
      const typedPart = contentPart as { type?: unknown; text?: unknown; refusal?: unknown };
      if (typedPart.type === 'output_text' && typeof typedPart.text === 'string') {
        chunks.push(typedPart.text);
      } else if (typedPart.type === 'refusal' && typeof typedPart.refusal === 'string') {
        chunks.push(typedPart.refusal);
      }
    }
  }
  return chunks.join('').trim();
}

export function mapFunctionCallArgs(rawArgs: unknown): unknown {
  if (typeof rawArgs === 'string') {
    try {
      return JSON.parse(rawArgs);
    } catch {
      return { raw: rawArgs };
    }
  }
  if (rawArgs && typeof rawArgs === 'object') {
    return rawArgs;
  }
  return undefined;
}

export function extractFunctionCallsFromCodexOutput(
  output: unknown,
): Array<{ name: string; args?: unknown }> {
  if (!Array.isArray(output)) return [];

  const calls: Array<{ name: string; args?: unknown }> = [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const typedItem = item as { type?: unknown; name?: unknown; arguments?: unknown };
    if (typedItem.type !== 'function_call') continue;
    const name = toNonEmptyString(typedItem.name);
    if (!name) continue;
    const args = mapFunctionCallArgs(typedItem.arguments);
    if (args !== undefined) {
      calls.push({ name, args });
    } else {
      calls.push({ name });
    }
  }
  return calls;
}

export function appendUniqueFunctionCalls(
  target: Array<{ name: string; args?: unknown }>,
  incoming: Array<{ name: string; args?: unknown }>,
): void {
  const existingKeys = new Set(
    target.map((call) => `${call.name}::${JSON.stringify(call.args ?? null)}`),
  );
  for (const call of incoming) {
    const key = `${call.name}::${JSON.stringify(call.args ?? null)}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    target.push(call);
  }
}

export function mapCodexUsage(
  payload: CodexUsagePayload | undefined,
): GatewayResponse['usage'] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const inputTokens = toNumberOrNull(payload.input_tokens);
  const outputTokens = toNumberOrNull(payload.output_tokens);
  const totalTokens = toNumberOrNull(payload.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return undefined;

  const cachedTokens = toNumberOrNull(payload.input_tokens_details?.cached_tokens) ?? 0;
  const promptTokens = Math.max(0, (inputTokens ?? 0) - Math.max(0, cachedTokens));
  const completionTokens = Math.max(0, outputTokens ?? 0);
  const combinedTotal = Math.max(0, totalTokens ?? promptTokens + completionTokens);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: combinedTotal,
  };
}
