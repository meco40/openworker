import type { GatewayResponse } from '@/server/model-hub/Models/types';
import type { CodexSseEvent } from '../types';
import { toNonEmptyString, toStringOrNull } from '../utils/typeGuards';
import {
  extractFunctionCallsFromCodexOutput,
  extractTextFromCodexOutput,
  mapCodexUsage,
  mapFunctionCallArgs,
  appendUniqueFunctionCalls,
} from './responseParser';
import { toCodexStreamError } from './errorParser';

export function parseSseEvents(chunk: string): CodexSseEvent[] {
  const normalized = chunk.replace(/\r/g, '');
  const entries = normalized.split('\n\n');
  const events: CodexSseEvent[] = [];

  for (const entry of entries) {
    if (!entry.trim()) continue;
    const dataLines = entry
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as CodexSseEvent;
      events.push(parsed);
    } catch {
      continue;
    }
  }

  return events;
}

export async function parseCodexSseResponse(
  response: Response,
  onStreamDelta?: (delta: string) => void,
): Promise<{
  text: string;
  model?: string;
  usage?: GatewayResponse['usage'];
  functionCalls?: Array<{ name: string; args?: unknown }>;
}> {
  if (!response.body) {
    throw new Error('OpenAI Codex response stream was empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deltas: string[] = [];
  let fallbackText = '';
  let model: string | undefined;
  let usage: GatewayResponse['usage'] | undefined;
  const functionCalls: Array<{ name: string; args?: unknown }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf('\n\n');
    if (boundary < 0) continue;

    const completeChunk = buffer.slice(0, boundary + 2);
    buffer = buffer.slice(boundary + 2);
    const events = parseSseEvents(completeChunk);

    for (const event of events) {
      const type = toNonEmptyString(event.type);
      if (!type) continue;

      if (type === 'error') {
        throw new Error(toCodexStreamError(event) || 'OpenAI Codex stream failed.');
      }

      if (type === 'response.failed') {
        throw new Error(
          toNonEmptyString(event.response?.error?.message) ||
            toCodexStreamError(event) ||
            'OpenAI Codex response failed.',
        );
      }

      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const delta = toStringOrNull(event.delta);
        if (delta !== null) {
          deltas.push(delta);
          if (onStreamDelta) onStreamDelta(delta);
        }
      }

      if (type === 'response.output_item.done') {
        const item = event.item;
        if (!item || typeof item !== 'object') continue;
        const typedItem = item as {
          type?: unknown;
          content?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (typedItem.type === 'function_call') {
          const name = toNonEmptyString(typedItem.name);
          if (name) {
            const args = mapFunctionCallArgs(typedItem.arguments);
            appendUniqueFunctionCalls(
              functionCalls,
              args !== undefined ? [{ name, args }] : [{ name }],
            );
          }
          continue;
        }
        if (deltas.length > 0 || fallbackText) continue;
        if (typedItem.type !== 'message' || !Array.isArray(typedItem.content)) continue;
        const chunks: string[] = [];
        for (const contentPart of typedItem.content) {
          if (!contentPart || typeof contentPart !== 'object') continue;
          const typedPart = contentPart as { type?: unknown; text?: unknown; refusal?: unknown };
          if (typedPart.type === 'output_text' && typeof typedPart.text === 'string') {
            chunks.push(typedPart.text);
          } else if (typedPart.type === 'refusal' && typeof typedPart.refusal === 'string') {
            chunks.push(typedPart.refusal);
          }
        }
        fallbackText = chunks.join('').trim();
      }

      if (type === 'response.completed' || type === 'response.done') {
        const responsePayload = event.response;
        const modelName = toNonEmptyString(responsePayload?.model);
        if (modelName) model = modelName;
        usage = mapCodexUsage(responsePayload?.usage) ?? usage;
        appendUniqueFunctionCalls(
          functionCalls,
          extractFunctionCallsFromCodexOutput(responsePayload?.output),
        );
        if (deltas.length === 0 && !fallbackText) {
          fallbackText = extractTextFromCodexOutput(responsePayload?.output);
        }
      }
    }
  }

  if (buffer.trim()) {
    for (const event of parseSseEvents(buffer)) {
      const type = toNonEmptyString(event.type);
      if (!type) continue;
      if (type === 'error') {
        throw new Error(toCodexStreamError(event) || 'OpenAI Codex stream failed.');
      }
      if (type === 'response.failed') {
        throw new Error(
          toNonEmptyString(event.response?.error?.message) ||
            toCodexStreamError(event) ||
            'OpenAI Codex response failed.',
        );
      }
    }
  }

  const text = deltas.join('').trim() || fallbackText;
  return {
    text,
    model,
    usage,
    functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
  };
}
