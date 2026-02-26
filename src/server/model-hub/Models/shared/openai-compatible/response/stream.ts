import type { GatewayResponse } from '@/server/model-hub/Models/types';
import { SSE_DATA_PREFIX, SSE_DONE_MARKER } from '../constants';
import type { SseChunk, StreamParseResult } from '../types';

export function extractSsePayloads(rawEventBlock: string): string[] {
  const lines = rawEventBlock.split('\n');
  const dataLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(SSE_DATA_PREFIX)) continue;
    dataLines.push(trimmed.slice(SSE_DATA_PREFIX.length).trim());
  }

  if (dataLines.length === 0) return [];
  return [dataLines.join('\n')];
}

export function mapStreamUsage(rawUsage: unknown): GatewayResponse['usage'] | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;

  const usage = rawUsage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };

  const prompt =
    typeof usage.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens)
      ? usage.prompt_tokens
      : 0;

  const completion =
    typeof usage.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : 0;

  const total =
    typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : prompt + completion;

  return {
    prompt_tokens: Math.max(0, prompt),
    completion_tokens: Math.max(0, completion),
    total_tokens: Math.max(0, total),
  };
}

interface ToolCallAccumulator {
  name: string;
  argsBuffer: string;
}

export async function parseOpenAICompatibleSseResponse(
  response: Response,
  onDelta?: (delta: string) => void,
): Promise<StreamParseResult> {
  if (!response.body) {
    throw new Error('Streaming response body is empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let model: string | undefined;
  let usage: GatewayResponse['usage'] | undefined;
  const toolCallsByIndex = new Map<number, ToolCallAccumulator>();

  const processBlock = (block: string): void => {
    const payloads = extractSsePayloads(block);

    for (const payload of payloads) {
      if (!payload || payload === SSE_DONE_MARKER) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;

      const chunk = parsed as SseChunk;

      if (typeof chunk.model === 'string' && chunk.model.trim().length > 0) {
        model = chunk.model.trim();
      }

      const mappedUsage = mapStreamUsage(chunk.usage);
      if (mappedUsage) usage = mappedUsage;

      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        text += delta;
        if (onDelta) onDelta(delta);
      }

      const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          const index =
            typeof toolCall?.index === 'number' && Number.isFinite(toolCall.index)
              ? toolCall.index
              : 0;
          const existing = toolCallsByIndex.get(index) || { name: '', argsBuffer: '' };

          const name = toolCall?.function?.name;
          if (typeof name === 'string' && name.trim()) {
            existing.name = name.trim();
          }

          const argsChunk = toolCall?.function?.arguments;
          if (typeof argsChunk === 'string' && argsChunk.length > 0) {
            existing.argsBuffer += argsChunk;
          }

          toolCallsByIndex.set(index, existing);
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');

    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processBlock(block);
      boundary = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim().length > 0) {
    processBlock(buffer);
  }

  const functionCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => {
      const name = call.name.trim();
      if (!name) return null;

      const rawArgs = call.argsBuffer.trim();
      if (!rawArgs) {
        return { name };
      }
      try {
        return { name, args: JSON.parse(rawArgs) };
      } catch {
        return { name, args: { raw: rawArgs } };
      }
    })
    .filter((call): call is { name: string; args?: unknown } => Boolean(call));

  return {
    text,
    model,
    usage,
    functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
  };
}
