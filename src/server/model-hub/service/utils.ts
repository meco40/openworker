import type { PipelineReasoningEffort, GatewayRequest } from './types';

export const EMBEDDING_PROFILE_ID = 'p1-embeddings';

export function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

export function normalizeBearerSecret(secret: string): string {
  return secret
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

export function extractTextParts(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (!Array.isArray(value)) return [];

  const texts: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) texts.push(text);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const parts = (entry as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) {
        texts.push(text.trim());
      }
    }
  }
  return texts;
}

export function tryExtractBatchPayloadAsEmbedContent(
  payload: Record<string, unknown>,
): { model: string; contents: string[] } | null {
  const requests = Array.isArray(payload.requests) ? payload.requests : null;
  if (!requests || requests.length === 0) return null;

  const first = requests[0];
  if (!first || typeof first !== 'object') return null;
  const firstModel = (first as { model?: unknown }).model;
  if (typeof firstModel !== 'string' || !firstModel.trim()) return null;

  const contents: string[] = [];
  for (const request of requests) {
    if (!request || typeof request !== 'object') continue;
    const req = request as {
      contents?: unknown;
      content?: { parts?: Array<{ text?: unknown }> };
    };

    if (Array.isArray(req.contents)) {
      for (const entry of req.contents) {
        if (typeof entry === 'string' && entry.trim()) {
          contents.push(entry);
        } else if (
          entry &&
          typeof entry === 'object' &&
          Array.isArray((entry as { parts?: unknown }).parts)
        ) {
          for (const part of (entry as { parts: Array<{ text?: unknown }> }).parts) {
            if (typeof part?.text === 'string' && part.text.trim()) {
              contents.push(part.text);
            }
          }
        }
      }
    } else if (req.content && Array.isArray(req.content.parts)) {
      for (const part of req.content.parts) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          contents.push(part.text);
        }
      }
    }
  }

  if (contents.length === 0) return null;
  return { model: firstModel.trim(), contents };
}

export function mapPipelineReasoningEffort(
  reasoningEffort?: PipelineReasoningEffort,
): GatewayRequest['reasoning_effort'] | undefined {
  if (!reasoningEffort || reasoningEffort === 'off') {
    return undefined;
  }
  if (reasoningEffort === 'minimal') {
    return 'low';
  }
  if (reasoningEffort === 'xhigh') {
    return 'high';
  }
  if (reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high') {
    return reasoningEffort;
  }
  return undefined;
}
