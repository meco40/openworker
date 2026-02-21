import type { GatewayRequest, GatewayResponse } from '@/server/model-hub/Models/types';
import { fetchWithTimeout } from '../../shared/http';
import { CODEX_REQUEST_TIMEOUT_MS } from '../constants';
import { buildCodexRequestBody } from '../mappers/requestMapper';
import { parseCodexSseResponse } from '../parsers/sseParser';
import { parseCodexHttpError } from '../parsers/errorParser';
import { buildCodexHeaders, resolveCodexEndpoint } from './config';

export async function dispatchCodexResponses(
  secret: string,
  request: GatewayRequest,
  options?: { signal?: AbortSignal; onStreamDelta?: (delta: string) => void },
): Promise<GatewayResponse> {
  const endpoint = resolveCodexEndpoint();
  let headers: Record<string, string>;

  try {
    headers = buildCodexHeaders(secret);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to build OpenAI Codex headers.';
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'openai-codex',
      error: message,
    };
  }

  const body = buildCodexRequestBody(request);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      CODEX_REQUEST_TIMEOUT_MS,
      options?.signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI Codex request failed.';
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'openai-codex',
      error: message,
    };
  }

  if (!response.ok) {
    const rawError = await response.text().catch(() => '');
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'openai-codex',
      error: parseCodexHttpError(rawError, response.status),
    };
  }

  try {
    const parsed = await parseCodexSseResponse(response, options?.onStreamDelta);
    return {
      ok: true,
      text: parsed.text,
      model: parsed.model || request.model,
      provider: 'openai-codex',
      usage: parsed.usage,
      functionCalls: parsed.functionCalls,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI Codex stream parse failed.';
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'openai-codex',
      error: message,
    };
  }
}
