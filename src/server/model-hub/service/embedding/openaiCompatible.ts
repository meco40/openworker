import { fetchWithTimeout, parseErrorMessage } from '@/server/model-hub/Models/shared/http';
import type { OpenAICompatibleEmbeddingResponse } from '../types';
import {
  normalizeBearerSecret,
  extractTextParts,
  tryExtractBatchPayloadAsEmbedContent,
  asPositiveInteger,
} from '../utils';

export function normalizeOpenAICompatibleEmbeddingInput(
  operation: 'embedContent' | 'batchEmbedContents',
  payload: Record<string, unknown>,
  fallbackModel: string,
): { model: string; input: string[]; dimensions?: number } | null {
  const requestedModel =
    typeof payload.model === 'string' && payload.model.trim().length > 0
      ? payload.model.trim()
      : '';
  const model = requestedModel || fallbackModel.trim();
  if (!model) return null;
  const dimensions = asPositiveInteger(payload.dimensions);

  if (payload.input !== undefined) {
    if (typeof payload.input === 'string' && payload.input.trim()) {
      return { model, input: [payload.input.trim()], dimensions };
    }
    if (Array.isArray(payload.input)) {
      const normalized = payload.input
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
      if (normalized.length > 0) {
        return { model, input: normalized, dimensions };
      }
    }
  }

  if (operation === 'embedContent') {
    const fromContents = extractTextParts(payload.contents);
    if (fromContents.length > 0) return { model, input: fromContents, dimensions };
    const fromContent = extractTextParts((payload as { content?: unknown }).content);
    if (fromContent.length > 0) return { model, input: fromContent, dimensions };
    return null;
  }

  const batchFallback = tryExtractBatchPayloadAsEmbedContent(payload);
  if (batchFallback) {
    return {
      model: requestedModel || batchFallback.model || model,
      input: batchFallback.contents,
      dimensions,
    };
  }

  const fromContents = extractTextParts(payload.contents);
  if (fromContents.length > 0) return { model, input: fromContents, dimensions };
  return null;
}

export async function dispatchOpenAICompatibleEmbedding(
  providerId: string,
  baseUrl: string,
  secret: string,
  operation: 'embedContent' | 'batchEmbedContents',
  payload: Record<string, unknown>,
  fallbackModel: string,
): Promise<Record<string, unknown>> {
  const normalized = normalizeOpenAICompatibleEmbeddingInput(operation, payload, fallbackModel);
  if (!normalized) {
    return { error: 'Embedding payload is missing a supported model/input format.' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const normalizedSecret = normalizeBearerSecret(secret);
  if (normalizedSecret) {
    headers.Authorization = `Bearer ${normalizedSecret}`;
  }
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://openclaw.app';
    headers['X-Title'] = 'OpenClaw';
  }

  const response = await fetchWithTimeout(
    `${baseUrl.replace(/\/$/, '')}/embeddings`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: normalized.model,
        input: normalized.input,
        ...(normalized.dimensions ? { dimensions: normalized.dimensions } : {}),
      }),
    },
    60_000,
  );

  if (!response.ok) {
    return { error: await parseErrorMessage(response) };
  }

  const json = (await response.json().catch(() => ({}))) as OpenAICompatibleEmbeddingResponse;
  const vectors = (json.data ?? [])
    .map((entry) => (Array.isArray(entry?.embedding) ? entry.embedding : []))
    .filter((embedding) => embedding.length > 0);

  if (operation === 'embedContent') {
    return { embedding: { values: vectors[0] ?? [] } };
  }
  return { embeddings: vectors.map((values) => ({ values })) };
}
