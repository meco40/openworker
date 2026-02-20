import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import { fetchJsonOk, fetchWithTimeout } from '@/server/model-hub/Models/shared/http';

const cohereProviderAdapter: ProviderAdapter = {
  id: 'cohere',

  async fetchModels({ secret }) {
    const response = await fetchWithTimeout('https://api.cohere.com/v2/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) return [];

    const json = (await response.json()) as {
      models?: Array<{ name: string; endpoints?: string[] }>;
    };

    return (json.models ?? [])
      .filter((model) => model.endpoints?.includes('chat'))
      .map((model) => ({ id: model.name, name: model.name, provider: 'cohere' }));
  },

  async testConnectivity({ secret }) {
    const result = await fetchJsonOk('https://api.cohere.com/v2/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });

    return result.ok
      ? { ok: true, message: 'Cohere connectivity verified (models list reachable).' }
      : { ok: false, message: `Cohere connectivity failed: ${result.message}` };
  },

  async dispatchGateway({ secret }, request) {
    const systemMessage = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');

    const chatHistory = request.messages
      .filter((message) => message.role !== 'system')
      .slice(0, -1)
      .map((message) => ({
        role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: message.content,
      }));

    const lastUserMessage =
      request.messages.filter((message) => message.role === 'user').pop()?.content ?? '';

    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        ...(systemMessage ? [{ role: 'system', content: systemMessage }] : []),
        ...chatHistory,
        { role: 'user', content: lastUserMessage },
      ],
      stream: false,
    };

    if (request.max_tokens) body.max_tokens = request.max_tokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const response = await fetchWithTimeout(
      'https://api.cohere.com/v2/chat',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      60_000,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText) as { message?: string };
        errorMessage = errorJson.message ?? errorText ?? `HTTP ${response.status}`;
      } catch {
        errorMessage = errorText || `HTTP ${response.status}`;
      }

      return {
        ok: false,
        text: '',
        model: request.model,
        provider: 'cohere',
        error: errorMessage,
      };
    }

    const json = (await response.json()) as {
      message?: { content?: Array<{ type: string; text?: string }> };
      usage?: {
        tokens?: { input_tokens?: number; output_tokens?: number };
        billed_units?: { input_tokens?: number; output_tokens?: number };
      };
    };

    const text =
      json.message?.content
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('') ?? '';

    const usage = json.usage?.tokens ?? json.usage?.billed_units;
    return {
      ok: true,
      text,
      model: request.model,
      provider: 'cohere',
      usage: usage
        ? {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          }
        : undefined,
    };
  },
};

export default cohereProviderAdapter;
