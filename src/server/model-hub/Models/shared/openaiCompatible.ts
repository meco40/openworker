import type { ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse } from '../types';
import { fetchWithTimeout } from './http';

const GATEWAY_TIMEOUT_MS = 60_000;

export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  secret: string,
  providerId: string,
): Promise<FetchedModel[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    },
  );

  if (!response.ok) return [];

  const json = (await response.json()) as {
    data?: Array<{ id: string; owned_by?: string; created?: number }>;
  };

  return (json.data ?? []).map((model) => ({
    id: model.id,
    name: model.id,
    provider: providerId,
    owned_by: model.owned_by,
    created: model.created,
  }));
}

export async function testOpenAICompatibleModelsEndpoint(
  baseUrl: string,
  secret: string,
  successMessage: string,
  failurePrefix: string,
): Promise<ConnectivityResult> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${secret}` },
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        message: `${failurePrefix}${text || `HTTP ${response.status}`}`,
      };
    }

    return { ok: true, message: successMessage };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed.';
    return { ok: false, message: `${failurePrefix}${message}` };
  }
}

export async function dispatchOpenAICompatibleChat(
  baseUrl: string,
  secret: string,
  providerId: string,
  request: GatewayRequest,
  options: { extraHeaders?: Record<string, string> } = {},
): Promise<GatewayResponse> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    max_tokens: request.max_tokens ?? 4096,
    temperature: request.temperature ?? 0.7,
    stream: false,
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
    ...(options.extraHeaders ?? {}),
  };

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    GATEWAY_TIMEOUT_MS,
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorText) as { error?: { message?: string } | string };
      if (typeof errorJson.error === 'string') {
        errorMessage = errorJson.error;
      } else if (typeof errorJson.error?.message === 'string') {
        errorMessage = errorJson.error.message;
      } else {
        errorMessage = errorText || `HTTP ${response.status}`;
      }
    } catch {
      errorMessage = errorText || `HTTP ${response.status}`;
    }

    return {
      ok: false,
      text: '',
      model: request.model,
      provider: providerId,
      error: errorMessage,
    };
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };

  return {
    ok: true,
    text: json.choices?.[0]?.message?.content ?? '',
    model: json.model ?? request.model,
    provider: providerId,
    usage: json.usage
      ? {
          prompt_tokens: json.usage.prompt_tokens ?? 0,
          completion_tokens: json.usage.completion_tokens ?? 0,
          total_tokens: json.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
