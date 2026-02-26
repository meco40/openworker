/**
 * OpenAI-Compatible Model Provider
 *
 * Modular implementation for OpenAI-compatible API providers.
 * Provides chat completion, model fetching, and connectivity testing.
 */

import type { GatewayRequest, GatewayResponse } from '@/server/model-hub/Models/types';
import { fetchWithTimeout } from '@/server/model-hub/Models/shared/http';
import { buildChatUrl, stripThinkingBlocks } from './utils';
import { buildRequestBody, buildRequestHeaders, resolveTimeoutMs } from './request';
import {
  parseChatResponse,
  parseOpenAICompatibleSseResponse,
  parseErrorResponse,
} from './response';
import { CONTENT_TYPE_EVENT_STREAM } from './constants';
import type { DispatchOptions } from './types';

// Re-export all public functions
export { fetchOpenAICompatibleModels, testOpenAICompatibleModelsEndpoint } from './models';

export { buildOpenAICompatibleMessages, buildRequestBody, buildRequestHeaders } from './request';

export {
  parseChatResponse,
  parseOpenAICompatibleSseResponse,
  parseErrorResponse,
  createErrorResponse,
} from './response';

export {
  normalizeBearerSecret,
  buildOptionalAuthHeaders,
  isImageAttachment,
  isTextAttachment,
  readTextAttachmentSnippet,
  attachmentFallbackText,
  normalizeBaseUrl,
  buildModelsUrl,
  buildChatUrl,
  stripThinkingBlocks,
} from './utils';

export * from './types';
export * from './constants';

/**
 * Dispatch a chat completion request to an OpenAI-compatible API.
 */
export async function dispatchOpenAICompatibleChat(
  baseUrl: string,
  secret: string,
  providerId: string,
  request: GatewayRequest,
  options: DispatchOptions = {},
): Promise<GatewayResponse> {
  const url = buildChatUrl(baseUrl);
  const wantsStream = request.stream === true;
  const timeoutMs = resolveTimeoutMs(Array.isArray(request.tools) && request.tools.length > 0);

  const body = buildRequestBody(request, providerId);
  const headers = buildRequestHeaders(secret, options.extraHeaders);

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    timeoutMs,
    options.signal,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return parseErrorResponse(response.status, errorText, request.model, providerId);
  }

  const responseContentType = response.headers.get('content-type') || '';
  if (wantsStream && responseContentType.toLowerCase().includes(CONTENT_TYPE_EVENT_STREAM)) {
    const parsedStream = await parseOpenAICompatibleSseResponse(response, options.onStreamDelta);
    const streamedText = stripThinkingBlocks(parsedStream.text);
    return {
      ok: true,
      text: streamedText,
      model: parsedStream.model || request.model,
      provider: providerId,
      usage: parsedStream.usage,
      functionCalls: parsedStream.functionCalls,
    };
  }

  const json = await response.json();
  return parseChatResponse(json, request.model, providerId);
}
