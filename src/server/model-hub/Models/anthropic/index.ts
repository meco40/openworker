import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import { fetchJsonOk, fetchWithTimeout } from '@/server/model-hub/Models/shared/http';

const anthropicProviderAdapter: ProviderAdapter = {
  id: 'anthropic',

  async fetchModels() {
    const models = [
      'claude-sonnet-4-5',
      'claude-3-7-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-opus-latest',
      'claude-3-5-sonnet-latest',
    ];
    return models.map((id) => ({ id, name: id, provider: 'anthropic' }));
  },

  async testConnectivity({ provider, secret }, options = {}) {
    const model = options.model || provider.defaultModels[0];
    if (!model) {
      return { ok: false, message: 'Anthropic test requires a model id.' };
    }

    const result = await fetchJsonOk('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': secret,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    return result.ok
      ? { ok: true, message: 'Anthropic connectivity verified.' }
      : { ok: false, message: `Anthropic connectivity failed: ${result.message}` };
  },

  async dispatchGateway({ secret }, request, options) {
    const systemMessages = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');

    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      }));

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens ?? 4096,
    };

    if (systemMessages) body.system = systemMessages;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const response = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': secret,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      60_000,
      options?.signal,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText) as { error?: { message?: string } };
        errorMessage = errorJson.error?.message ?? errorText ?? `HTTP ${response.status}`;
      } catch {
        errorMessage = errorText || `HTTP ${response.status}`;
      }

      return {
        ok: false,
        text: '',
        model: request.model,
        provider: 'anthropic',
        error: errorMessage,
      };
    }

    const json = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };

    const text =
      json.content
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('') ?? '';

    return {
      ok: true,
      text,
      model: json.model ?? request.model,
      provider: 'anthropic',
      usage: json.usage
        ? {
            prompt_tokens: json.usage.input_tokens ?? 0,
            completion_tokens: json.usage.output_tokens ?? 0,
            total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  },
};

export default anthropicProviderAdapter;
