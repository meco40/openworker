import type {
  GatewayRequest,
  ProviderAdapter,
} from '@/server/model-hub/Models/types';
import { fetchJsonOk, fetchWithTimeout } from '@/server/model-hub/Models/shared/http';
import {
  readStoredAttachmentAsDataUrl,
} from '@/server/channels/messages/attachments';

// Anthropic content block types
interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

// Tool definition for Anthropic
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

function isImageAttachment(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('image/');
}

function extractBase64FromDataUrl(dataUrl: string): { data: string; mediaType: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { data: match[2], mediaType: match[1] };
}

function mapOpenAIToolToAnthropic(rawTool: unknown): AnthropicTool | null {
  if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) return null;

  const tool = rawTool as {
    type?: unknown;
    function?: {
      name?: unknown;
      description?: unknown;
      parameters?: {
        type?: unknown;
        properties?: Record<string, unknown>;
        required?: unknown;
      };
    };
  };

  if (tool.type !== 'function' || !tool.function) return null;

  const name = typeof tool.function.name === 'string' ? tool.function.name : null;
  if (!name) return null;

  const description =
    typeof tool.function.description === 'string' ? tool.function.description : '';

  const parameters = tool.function.parameters;
  const inputSchema: AnthropicTool['input_schema'] = {
    type: 'object',
  };

  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
    if (parameters.properties && typeof parameters.properties === 'object') {
      inputSchema.properties = parameters.properties;
    }
    if (Array.isArray(parameters.required)) {
      inputSchema.required = parameters.required.filter((r): r is string => typeof r === 'string');
    }
  }

  return {
    name,
    description,
    input_schema: inputSchema,
  };
}

function buildAnthropicContentBlocks(
  message: GatewayRequest['messages'][number],
  includeBinaryAttachments: boolean,
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  const trimmedContent = message.content.trim();

  if (trimmedContent) {
    blocks.push({ type: 'text', text: trimmedContent });
  }

  for (const attachment of message.attachments || []) {
    const mimeType = attachment.mimeType || 'application/octet-stream';

    if (includeBinaryAttachments && isImageAttachment(mimeType)) {
      const dataUrl = readStoredAttachmentAsDataUrl(attachment);
      if (dataUrl) {
        const extracted = extractBase64FromDataUrl(dataUrl);
        if (extracted) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: extracted.mediaType,
              data: extracted.data,
            },
          });
          continue;
        }
      }
    }

    // Fallback for non-image attachments
    blocks.push({
      type: 'text',
      text: `[Attachment: ${attachment.name} (${mimeType}, ${attachment.size} bytes)]`,
    });
  }

  return blocks;
}

function buildAnthropicMessages(
  messages: GatewayRequest['messages'],
): Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] | string }> {
  const result: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] | string }> =
    [];

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
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      const content = buildAnthropicContentBlocks(message, index === latestUserAttachmentIndex);
      if (content.length > 0) {
        result.push({ role: 'user', content });
      }
    } else {
      // Assistant role
      const trimmedContent = message.content.trim();
      if (trimmedContent) {
        result.push({ role: 'assistant', content: trimmedContent });
      }
    }
  }

  return result;
}

function extractAnthropicFunctionCalls(
  contentBlocks: unknown[],
): Array<{ name: string; args?: unknown }> {
  const calls: Array<{ name: string; args?: unknown }> = [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;

    const typedBlock = block as {
      type?: unknown;
      name?: unknown;
      input?: unknown;
    };

    if (typedBlock.type === 'tool_use' && typeof typedBlock.name === 'string') {
      calls.push({
        name: typedBlock.name,
        args: typedBlock.input,
      });
    }
  }

  return calls;
}

const anthropicProviderAdapter: ProviderAdapter = {
  id: 'anthropic',

  async fetchModels() {
    const models = [
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250514',
      'claude-3-7-sonnet-latest',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-haiku-latest',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-latest',
      'claude-3-opus-20240229',
      'claude-3-5-sonnet-latest',
      'claude-3-5-sonnet-20241022',
    ];
    return models.map((id) => ({ id, name: id, provider: 'anthropic' }));
  },

  async testConnectivity({ provider, secret }, options = {}) {
    const model = options.model || provider.defaultModels[0];
    if (!model) {
      return { ok: false, message: 'Anthropic test requires a model id.' };
    }

    const result = await fetchJsonOk(`${ANTHROPIC_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': secret,
        'anthropic-version': ANTHROPIC_API_VERSION,
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
    try {
      // Extract system messages
      const systemMessages = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');

      // Build messages with content blocks
      const messages = buildAnthropicMessages(request.messages);

      if (messages.length === 0) {
        return {
          ok: false,
          text: '',
          model: request.model,
          provider: 'anthropic',
          error: 'No valid messages to send',
        };
      }

      // Build request body
      const body: Record<string, unknown> = {
        model: request.model,
        messages,
        max_tokens: request.max_tokens ?? 4096,
      };

      if (systemMessages) {
        body.system = systemMessages;
      }

      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }

      // Map tools to Anthropic format
      if (Array.isArray(request.tools) && request.tools.length > 0) {
        const tools = request.tools
          .map((tool) => mapOpenAIToolToAnthropic(tool))
          .filter((tool): tool is AnthropicTool => tool !== null);

        if (tools.length > 0) {
          body.tools = tools;
        }
      }

      const response = await fetchWithTimeout(
        `${ANTHROPIC_BASE_URL}/messages`,
        {
          method: 'POST',
          headers: {
            'x-api-key': secret,
            'anthropic-version': ANTHROPIC_API_VERSION,
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
        content?: Array<{
          type: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
      };

      // Extract text from content blocks
      const text =
        json.content
          ?.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('') ?? '';

      // Extract function calls from tool_use blocks
      const functionCalls = extractAnthropicFunctionCalls(json.content ?? []);

      return {
        ok: true,
        text,
        model: json.model ?? request.model,
        provider: 'anthropic',
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        usage: json.usage
          ? {
              prompt_tokens: json.usage.input_tokens ?? 0,
              completion_tokens: json.usage.output_tokens ?? 0,
              total_tokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
            }
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Anthropic request failed';
      return {
        ok: false,
        text: '',
        model: request.model,
        provider: 'anthropic',
        error: message,
      };
    }
  },
};

export default anthropicProviderAdapter;
