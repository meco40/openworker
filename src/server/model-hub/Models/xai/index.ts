import type {
  FetchedModel,
  GatewayRequest,
  GatewayResponse,
  ProviderAdapter,
} from '@/server/model-hub/Models/types';
import { fetchJsonOk, fetchWithTimeout } from '@/server/model-hub/Models/shared/http';
import {
  readStoredAttachmentAsDataUrl,
  readStoredAttachmentBuffer,
} from '@/server/channels/messages/attachments';

// xAI Responses API types
interface XAIInputMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<XAIContentPart>;
}

interface XAITextContentPart {
  type: 'text';
  text: string;
}

interface XAIImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

type XAIContentPart = XAITextContentPart | XAIImageContentPart;

interface XAIFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

interface XAIOutputItem {
  type: 'message' | 'function_call' | string;
  role?: 'assistant';
  content?: Array<{
    type: string;
    text?: string;
  }>;
  name?: string;
  arguments?: string | Record<string, unknown>;
  call_id?: string;
}

interface XAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

const XAI_BASE_URL = 'https://api.x.ai/v1';

function isImageAttachment(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('image/');
}

function isTextAttachment(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return normalized.startsWith('text/') || normalized === 'application/json';
}

function readTextAttachmentSnippet(
  attachment: NonNullable<GatewayRequest['messages'][number]['attachments']>[number],
): string | null {
  try {
    const bytes = readStoredAttachmentBuffer(attachment);
    if (!bytes.length) return null;
    const text = bytes.toString('utf8').replaceAll('\u0000', '').trim();
    if (!text) return null;
    return text.slice(0, 12_000);
  } catch {
    return null;
  }
}

function buildXAIInputMessages(messages: GatewayRequest['messages']): XAIInputMessage[] {
  const result: XAIInputMessage[] = [];

  // Find the latest user message with attachments for image inclusion
  const latestUserAttachmentIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      if ((message.attachments?.length || 0) > 0) return index;
    }
    return -1;
  })();

  for (const [index, message] of messages.entries()) {
    const attachments = message.attachments || [];

    if (message.role === 'system') {
      result.push({
        role: 'system',
        content: message.content,
      });
      continue;
    }

    if (message.role === 'assistant') {
      result.push({
        role: 'assistant',
        content: message.content,
      });
      continue;
    }

    // User message - handle attachments
    if (attachments.length === 0) {
      result.push({
        role: 'user',
        content: message.content,
      });
      continue;
    }

    // Build content parts with attachments
    const contentParts: XAIContentPart[] = [];
    const textParts: string[] = [];
    const trimmedContent = message.content.trim();

    if (trimmedContent) {
      textParts.push(trimmedContent);
    }

    const includeBinaryAttachments = index === latestUserAttachmentIndex;

    for (const attachment of attachments) {
      if (includeBinaryAttachments && isImageAttachment(attachment.mimeType)) {
        const dataUrl = readStoredAttachmentAsDataUrl(attachment);
        if (dataUrl) {
          // Flush text parts first
          if (textParts.length > 0) {
            contentParts.push({
              type: 'text',
              text: textParts.join('\n\n'),
            });
            textParts.length = 0;
          }
          contentParts.push({
            type: 'image_url',
            image_url: { url: dataUrl },
          });
          continue;
        }
      }

      if (includeBinaryAttachments && isTextAttachment(attachment.mimeType)) {
        const snippet = readTextAttachmentSnippet(attachment);
        if (snippet) {
          textParts.push(`Attachment ${attachment.name} (${attachment.mimeType}):\n${snippet}`);
          continue;
        }
      }

      textParts.push(
        `[Attachment: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)]`,
      );
    }

    // Add remaining text parts
    if (textParts.length > 0) {
      contentParts.push({
        type: 'text',
        text: textParts.join('\n\n'),
      });
    }

    result.push({
      role: 'user',
      content: contentParts,
    });
  }

  return result;
}

function mapOpenAIToolToXAI(rawTool: unknown): XAIFunctionTool | null {
  if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) return null;

  const tool = rawTool as {
    type?: unknown;
    name?: unknown;
    description?: unknown;
    parameters?: Record<string, unknown>;
    strict?: unknown;
    function?: {
      name?: unknown;
      description?: unknown;
      parameters?: Record<string, unknown>;
      strict?: unknown;
    };
  };

  if (tool.type !== 'function') return null;

  const directName = typeof tool.name === 'string' ? tool.name.trim() : '';
  const nestedName = typeof tool.function?.name === 'string' ? tool.function.name.trim() : '';
  const name = directName || nestedName;
  if (!name) return null;

  const directDescription = typeof tool.description === 'string' ? tool.description : undefined;
  const nestedDescription =
    typeof tool.function?.description === 'string' ? tool.function.description : undefined;
  const description = directDescription ?? nestedDescription;

  const parameters = tool.parameters ?? tool.function?.parameters;

  const directStrict = typeof tool.strict === 'boolean' ? tool.strict : undefined;
  const nestedStrict =
    typeof tool.function?.strict === 'boolean' ? tool.function.strict : undefined;
  const strict = directStrict ?? nestedStrict;

  return {
    type: 'function',
    name,
    description,
    parameters,
    strict,
  };
}

function extractXAIFunctionCalls(output: unknown[]): Array<{ name: string; args?: unknown }> {
  const calls: Array<{ name: string; args?: unknown }> = [];

  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const typedItem = item as {
      type?: unknown;
      name?: unknown;
      arguments?: string | Record<string, unknown>;
    };

    if (typedItem.type === 'function_call' && typeof typedItem.name === 'string') {
      const name = typedItem.name;
      const rawArgs = typedItem.arguments;

      if (typeof rawArgs === 'string') {
        try {
          calls.push({ name, args: JSON.parse(rawArgs) });
        } catch {
          calls.push({ name, args: { raw: rawArgs } });
        }
      } else if (rawArgs && typeof rawArgs === 'object') {
        calls.push({ name, args: rawArgs });
      } else {
        calls.push({ name });
      }
    }
  }

  return calls;
}

function extractTextFromXAIOutput(output: unknown[]): string {
  const texts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const typedItem = item as {
      type?: unknown;
      content?: Array<{ type?: unknown; text?: unknown }>;
    };

    if (typedItem.type === 'message' && Array.isArray(typedItem.content)) {
      for (const contentItem of typedItem.content) {
        if (
          contentItem &&
          typeof contentItem === 'object' &&
          contentItem.type === 'output_text' &&
          typeof contentItem.text === 'string'
        ) {
          texts.push(contentItem.text);
        }
      }
    }
  }

  return texts.join('').trim();
}

const xAIProviderAdapter: ProviderAdapter = {
  id: 'xai',

  async fetchModels({ secret }): Promise<FetchedModel[]> {
    const response = await fetchWithTimeout(`${XAI_BASE_URL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });

    if (!response.ok) return [];

    const json = (await response.json()) as {
      data?: Array<{ id: string; owned_by?: string; created?: number }>;
    };

    return (json.data ?? []).map((model) => ({
      id: model.id,
      name: model.id,
      provider: 'xai',
      owned_by: model.owned_by,
      created: model.created,
    }));
  },

  async testConnectivity({ secret }) {
    const result = await fetchJsonOk(`${XAI_BASE_URL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    });

    return result.ok
      ? { ok: true, message: 'xAI connectivity verified (models list reachable).' }
      : { ok: false, message: `xAI connectivity failed: ${result.message}` };
  },

  async dispatchGateway({ secret }, request, options): Promise<GatewayResponse> {
    try {
      const input = buildXAIInputMessages(request.messages);

      if (input.length === 0) {
        return {
          ok: false,
          text: '',
          model: request.model,
          provider: 'xai',
          error: 'No valid messages to send',
        };
      }

      // Build request body for Responses API
      const body: Record<string, unknown> = {
        model: request.model,
        input,
        store: false,
      };

      if (request.max_tokens) {
        body.max_tokens = request.max_tokens;
      }

      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }

      // Map tools
      if (Array.isArray(request.tools) && request.tools.length > 0) {
        const tools = request.tools
          .map((tool) => mapOpenAIToolToXAI(tool))
          .filter((tool): tool is XAIFunctionTool => tool !== null);

        if (tools.length > 0) {
          body.tools = tools;
          body.tool_choice = 'auto';
          body.parallel_tool_calls = true;
        }
      }

      const response = await fetchWithTimeout(
        `${XAI_BASE_URL}/responses`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${secret}`,
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
          provider: 'xai',
          error: errorMessage,
        };
      }

      const json = (await response.json()) as {
        output?: XAIOutputItem[];
        usage?: XAIUsage;
        model?: string;
      };

      const text = extractTextFromXAIOutput(json.output ?? []);
      const functionCalls = extractXAIFunctionCalls(json.output ?? []);

      return {
        ok: true,
        text,
        model: json.model ?? request.model,
        provider: 'xai',
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        usage: json.usage
          ? {
              prompt_tokens: json.usage.input_tokens ?? 0,
              completion_tokens: json.usage.output_tokens ?? 0,
              total_tokens: json.usage.total_tokens ?? 0,
            }
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'xAI request failed';
      return {
        ok: false,
        text: '',
        model: request.model,
        provider: 'xai',
        error: message,
      };
    }
  },
};

export default xAIProviderAdapter;
