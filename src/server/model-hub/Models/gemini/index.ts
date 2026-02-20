import { GoogleGenAI } from '@google/genai';
import type { ProviderAdapter } from '@/server/model-hub/Models/types';
import { fetchWithTimeout } from '@/server/model-hub/Models/shared/http';

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiGenerateContentResult {
  text?: string;
  usageMetadata?: GeminiUsageMetadata;
  functionCalls?: Array<{ name: string; args?: unknown }>;
  candidates?: Array<{
    content?: {
      parts?: Array<{ functionCall?: { name: string; args?: unknown } }>;
    };
  }>;
}

interface GeminiModelsApi {
  generateContent(payload: {
    model: string;
    contents: Array<{ role: 'model' | 'user'; parts: Array<{ text: string }> }>;
    config: Record<string, unknown>;
  }): Promise<GeminiGenerateContentResult>;
}

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

function mapOpenAiTypeToGemini(type: unknown): string {
  switch (String(type || '').toLowerCase()) {
    case 'number':
      return 'NUMBER';
    case 'integer':
      return 'INTEGER';
    case 'boolean':
      return 'BOOLEAN';
    case 'array':
      return 'ARRAY';
    case 'object':
      return 'OBJECT';
    default:
      return 'STRING';
  }
}

function normalizeGeminiTools(rawTools: unknown[]): unknown[] {
  const normalized: unknown[] = [];

  for (const rawTool of rawTools) {
    if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) {
      continue;
    }

    const tool = rawTool as {
      functionDeclarations?: unknown;
      type?: unknown;
      function?: {
        name?: unknown;
        description?: unknown;
        parameters?: {
          type?: unknown;
          properties?: Record<string, { type?: unknown; description?: unknown; enum?: unknown }>;
          required?: unknown;
        };
      };
    };

    if (Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0) {
      normalized.push(tool);
      continue;
    }

    if (tool.type !== 'function' || !tool.function || typeof tool.function.name !== 'string') {
      continue;
    }

    const rawParams =
      tool.function.parameters && typeof tool.function.parameters === 'object'
        ? tool.function.parameters
        : {};
    const rawProperties =
      rawParams.properties && typeof rawParams.properties === 'object' ? rawParams.properties : {};

    const properties: Record<string, { type: string; description?: string; enum?: string[] }> = {};
    for (const [name, property] of Object.entries(rawProperties)) {
      if (!property || typeof property !== 'object') continue;
      const typedProperty = property as {
        type?: unknown;
        description?: unknown;
        enum?: unknown;
      };
      const nextProperty: { type: string; description?: string; enum?: string[] } = {
        type: mapOpenAiTypeToGemini(typedProperty.type),
      };
      if (typeof typedProperty.description === 'string') {
        nextProperty.description = typedProperty.description;
      }
      if (Array.isArray(typedProperty.enum)) {
        const enumValues = typedProperty.enum
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean);
        if (enumValues.length > 0) {
          nextProperty.enum = enumValues;
        }
      }
      properties[name] = nextProperty;
    }

    const required = Array.isArray(rawParams.required)
      ? rawParams.required.filter((value): value is string => typeof value === 'string')
      : [];

    normalized.push({
      functionDeclarations: [
        {
          name: tool.function.name,
          description:
            typeof tool.function.description === 'string' ? tool.function.description : undefined,
          parameters: {
            type: mapOpenAiTypeToGemini(rawParams.type),
            properties,
            required,
          },
        },
      ],
    });
  }

  return normalized;
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

  async dispatchGateway({ secret }, request, options) {
    try {
      const ai = new GoogleGenAI({ apiKey: secret });

      // Check abort before starting the request
      if (options?.signal?.aborted) {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }

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
        const tools = normalizeGeminiTools(request.tools);
        if (tools.length > 0) {
          config.tools = tools;
        }
      }

      const generatePromise = (ai.models as GeminiModelsApi).generateContent({
        model: request.model,
        contents,
        config,
      });

      // Race with abort signal if provided
      let result: GeminiGenerateContentResult;
      if (options?.signal) {
        result = await Promise.race<GeminiGenerateContentResult>([
          generatePromise,
          new Promise<GeminiGenerateContentResult>((_resolve, reject) => {
            if (options.signal!.aborted) {
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
              return;
            }
            options.signal!.addEventListener(
              'abort',
              () => {
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
              },
              { once: true },
            );
          }),
        ]);
      } else {
        result = await generatePromise;
      }

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
