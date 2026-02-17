import type { ConnectivityResult, FetchedModel, GatewayRequest, GatewayResponse } from '../types';
import { fetchWithTimeout } from './http';
import {
  readStoredAttachmentAsDataUrl,
  readStoredAttachmentBuffer,
} from '../../../channels/messages/attachments';

const GATEWAY_TIMEOUT_MS = 60_000;

function normalizeBearerSecret(secret: string): string {
  let normalized = secret.trim();
  normalized = normalized.replace(/^[\r\n\t ]+|[\r\n\t ]+$/g, '');
  normalized = normalized.replace(/^['"`](.*)['"`]$/s, '$1').trim();
  normalized = normalized.replace(/^Bearer\s+/i, '').trim();
  normalized = normalized.replace(/\\[nrt]/g, '');
  normalized = normalized.replace(/[\r\n\t]/g, '');
  return normalized;
}

function buildOptionalAuthHeaders(secret: string): Record<string, string> {
  const normalizedSecret = normalizeBearerSecret(secret);
  if (!normalizedSecret) return {};
  return { Authorization: `Bearer ${normalizedSecret}` };
}

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
    const text = bytes
      .toString('utf8')
      .replace(/\u0000/g, '')
      .trim();
    if (!text) return null;
    return text.slice(0, 12_000);
  } catch {
    return null;
  }
}

function attachmentFallbackText(
  attachment: NonNullable<GatewayRequest['messages'][number]['attachments']>[number],
): string {
  return `[Attachment: ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)]`;
}

function buildOpenAICompatibleMessages(
  messages: GatewayRequest['messages'],
): Array<Record<string, unknown>> {
  const latestUserAttachmentIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      if ((message.attachments?.length || 0) > 0) return index;
    }
    return -1;
  })();

  return messages.map((message, index) => {
    const attachments = message.attachments || [];
    if (message.role !== 'user' || attachments.length === 0) {
      return {
        role: message.role,
        content: message.content,
      };
    }

    const contentParts: Array<Record<string, unknown>> = [];
    const textParts: string[] = [];
    const trimmedContent = message.content.trim();
    if (trimmedContent) {
      textParts.push(trimmedContent);
    }

    for (const attachment of attachments) {
      const includeBinaryAttachment = index === latestUserAttachmentIndex;
      if (includeBinaryAttachment && isImageAttachment(attachment.mimeType)) {
        const dataUrl = readStoredAttachmentAsDataUrl(attachment);
        if (dataUrl) {
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

      if (includeBinaryAttachment && isTextAttachment(attachment.mimeType)) {
        const snippet = readTextAttachmentSnippet(attachment);
        if (snippet) {
          textParts.push(`Attachment ${attachment.name} (${attachment.mimeType}):\n${snippet}`);
          continue;
        }
      }

      textParts.push(attachmentFallbackText(attachment));
    }

    if (textParts.length > 0) {
      contentParts.push({
        type: 'text',
        text: textParts.join('\n\n'),
      });
    }

    if (contentParts.length === 0) {
      return {
        role: message.role,
        content: message.content,
      };
    }

    return {
      role: message.role,
      content: contentParts,
    };
  });
}

export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  secret: string,
  providerId: string,
): Promise<FetchedModel[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: buildOptionalAuthHeaders(secret),
  });

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
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: buildOptionalAuthHeaders(secret),
    });

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
  options: { extraHeaders?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<GatewayResponse> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: buildOpenAICompatibleMessages(request.messages),
    max_tokens: request.max_tokens ?? 4096,
    temperature: request.temperature ?? 0.7,
    stream: false,
  };
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    body.tools = request.tools;
  }
  if (request.reasoning_effort && (providerId === 'openai' || providerId === 'openai-codex')) {
    body.reasoning_effort = request.reasoning_effort;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildOptionalAuthHeaders(secret),
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
    options.signal,
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
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: Array<{
          type?: string;
          function?: { name?: string; arguments?: unknown };
        }>;
        function_call?: { name?: string; arguments?: unknown };
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };

  let text = json.choices?.[0]?.message?.content ?? '';

  // Strip thinking/reasoning blocks that some models embed in content
  // e.g. DeepSeek R1, Grok 4 via OpenRouter: <think>...</think>
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const message = json.choices?.[0]?.message;
  const rawToolCalls = message?.tool_calls ?? [];
  const mappedToolCalls = rawToolCalls
    .map((toolCall) => {
      const name = toolCall?.function?.name?.trim();
      if (!name) return null;
      const rawArgs = toolCall.function?.arguments;
      if (typeof rawArgs === 'string') {
        try {
          return { name, args: JSON.parse(rawArgs) };
        } catch {
          return { name, args: { raw: rawArgs } };
        }
      }
      if (rawArgs && typeof rawArgs === 'object') {
        return { name, args: rawArgs };
      }
      return { name };
    })
    .filter((call): call is { name: string; args?: unknown } => Boolean(call));

  if (mappedToolCalls.length === 0 && message?.function_call?.name) {
    const name = message.function_call.name.trim();
    const rawArgs = message.function_call.arguments;
    if (name) {
      if (typeof rawArgs === 'string') {
        try {
          mappedToolCalls.push({ name, args: JSON.parse(rawArgs) });
        } catch {
          mappedToolCalls.push({ name, args: { raw: rawArgs } });
        }
      } else if (rawArgs && typeof rawArgs === 'object') {
        mappedToolCalls.push({ name, args: rawArgs });
      } else {
        mappedToolCalls.push({ name });
      }
    }
  }

  return {
    ok: true,
    text,
    model: json.model ?? request.model,
    provider: providerId,
    functionCalls: mappedToolCalls.length > 0 ? mappedToolCalls : undefined,
    usage: json.usage
      ? {
          prompt_tokens: json.usage.prompt_tokens ?? 0,
          completion_tokens: json.usage.completion_tokens ?? 0,
          total_tokens: json.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}
