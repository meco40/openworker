import { GoogleGenAI } from '@google/genai';
import type { ProviderAdapter } from '../types';
import { fetchWithTimeout } from '../shared/http';

function extractGeminiFunctionCalls(result: unknown): Array<{ name: string; args?: unknown }> {
  if (!result || typeof result !== 'object') return [];
  const typed = result as {
    functionCalls?: Array<{ name: string; args?: unknown }>;
    candidates?: Array<{
      content?: {
        parts?: Array<{ functionCall?: { name: string; args?: unknown } }>;
      };
    }>;
  };

  if (Array.isArray(typed.functionCalls) && typed.functionCalls.length > 0) {
    return typed.functionCalls;
  }

  const parts = typed.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.functionCall)
    .filter((call): call is { name: string; args?: unknown } => Boolean(call && call.name));
}

const geminiProviderAdapter: ProviderAdapter = {
  id: 'gemini',
  async fetchModels({ secret }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(secret)}&pageSize=100`;
    const response = await fetchWithTimeout(url, { method: 'GET' });
    if (!response.ok) return [];

    const json = (await response.json()) as {
      models?: Array<{
        name: string;
        displayName: string;
        inputTokenLimit?: number;
      }>;
    };

    return (json.models ?? [])
      .filter((model) => model.name.startsWith('models/gemini'))
      .map((model) => ({
        id: model.name.replace('models/', ''),
        name: model.displayName || model.name.replace('models/', ''),
        provider: 'gemini',
        context_window: model.inputTokenLimit,
      }));
  },

  async testConnectivity({ provider, secret }, options = {}) {
    try {
      const ai = new GoogleGenAI({ apiKey: secret });
      const model = options.model || provider.defaultModels[0] || 'gemini-2.5-flash';
      const result = await ai.models.generateContent({
        model,
        contents: 'Ping',
      });
      const hasText = Boolean(result?.text && String(result.text).trim().length > 0);
      return {
        ok: hasText,
        message: hasText ? 'Gemini connectivity verified.' : 'Gemini returned no content.',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gemini connectivity failed';
      return { ok: false, message };
    }
  },

  async dispatchGateway({ secret }, request) {
    try {
      const ai = new GoogleGenAI({ apiKey: secret });

      // Merge system messages from GatewayMessage[] with explicit systemInstruction
      const systemFromMessages = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      const systemInstruction = [request.systemInstruction, systemFromMessages]
        .filter(Boolean)
        .join('\n');

      const contents = request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
          parts: [{ text: message.content }],
        }));

      const config: Record<string, unknown> = {};
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (request.max_tokens) config.maxOutputTokens = request.max_tokens;
      if (request.temperature !== undefined) config.temperature = request.temperature;
      if (request.responseMimeType) config.responseMimeType = request.responseMimeType;
      if (Array.isArray(request.tools) && request.tools.length > 0) {
        config.tools = request.tools;
      }

      const result = await (ai.models as any).generateContent({
        model: request.model,
        contents,
        config,
      });

      // Extract function calls from Gemini response
      const functionCalls = extractGeminiFunctionCalls(result);

      const usage = result?.usageMetadata;
      return {
        ok: true,
        text: result?.text ?? '',
        model: request.model,
        provider: 'gemini',
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        usage: usage
          ? {
              prompt_tokens: usage.promptTokenCount ?? 0,
              completion_tokens: usage.candidatesTokenCount ?? 0,
              total_tokens: usage.totalTokenCount ?? 0,
            }
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Gemini request failed';
      return {
        ok: false,
        text: '',
        model: request.model,
        provider: 'gemini',
        error: message,
      };
    }
  },
};

export default geminiProviderAdapter;
