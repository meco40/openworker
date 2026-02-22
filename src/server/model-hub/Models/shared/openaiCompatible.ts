import type {
  ConnectivityResult,
  FetchedModel,
  GatewayRequest,
  GatewayResponse,
} from '@/server/model-hub/Models/types';
import { fetchWithTimeout } from '@/server/model-hub/Models/shared/http';
import {
  readStoredAttachmentAsDataUrl,
  readStoredAttachmentBuffer,
} from '@/server/channels/messages/attachments';

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
    const text = bytes.toString('utf8').replaceAll('\u0000', '').trim();
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
  options: {
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
    onStreamDelta?: (delta: string) => void;
  } = {},
): Promise<GatewayResponse> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const wantsStream = request.stream === true;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: buildOpenAICompatibleMessages(request.messages),
    max_tokens: request.max_tokens ?? 4096,
    temperature: request.temperature ?? 0.7,
    stream: wantsStream,
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

  const responseContentType = response.headers.get('content-type') || '';
  if (wantsStream && responseContentType.toLowerCase().includes('text/event-stream')) {
    const parsedStream = await parseOpenAICompatibleSseResponse(response, options.onStreamDelta);
    let streamedText = parsedStream.text;
    streamedText = streamedText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return {
      ok: true,
      text: streamedText,
      model: parsedStream.model || request.model,
      provider: providerId,
      usage: parsedStream.usage,
      functionCalls: parsedStream.functionCalls,
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

function extractSsePayloads(rawEventBlock: string): string[] {
  const lines = rawEventBlock.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    dataLines.push(trimmed.slice(5).trim());
  }
  if (dataLines.length === 0) return [];
  return [dataLines.join('\n')];
}

function mapStreamUsage(rawUsage: unknown): GatewayResponse['usage'] | undefined {
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;
  const usage = rawUsage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  const prompt =
    typeof usage.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens)
      ? usage.prompt_tokens
      : 0;
  const completion =
    typeof usage.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : 0;
  const total =
    typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : prompt + completion;
  return {
    prompt_tokens: Math.max(0, prompt),
    completion_tokens: Math.max(0, completion),
    total_tokens: Math.max(0, total),
  };
}

async function parseOpenAICompatibleSseResponse(
  response: Response,
  onDelta?: (delta: string) => void,
): Promise<{
  text: string;
  model?: string;
  usage?: GatewayResponse['usage'];
  functionCalls?: Array<{ name: string; args?: unknown }>;
}> {
  if (!response.body) {
    throw new Error('Streaming response body is empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let model: string | undefined;
  let usage: GatewayResponse['usage'] | undefined;
  const toolCallsByIndex = new Map<number, { name: string; argsBuffer: string }>();

  const processBlock = (block: string) => {
    const payloads = extractSsePayloads(block);
    for (const payload of payloads) {
      if (!payload || payload === '[DONE]') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;

      const chunk = parsed as {
        model?: unknown;
        usage?: unknown;
        choices?: Array<{
          delta?: {
            content?: unknown;
            tool_calls?: Array<{
              index?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            }>;
          };
        }>;
      };

      if (typeof chunk.model === 'string' && chunk.model.trim().length > 0) {
        model = chunk.model.trim();
      }
      const mappedUsage = mapStreamUsage(chunk.usage);
      if (mappedUsage) usage = mappedUsage;

      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        text += delta;
        if (onDelta) onDelta(delta);
      }

      const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          const index =
            typeof toolCall?.index === 'number' && Number.isFinite(toolCall.index)
              ? toolCall.index
              : 0;
          const existing = toolCallsByIndex.get(index) || { name: '', argsBuffer: '' };

          const name = toolCall?.function?.name;
          if (typeof name === 'string' && name.trim()) {
            existing.name = name.trim();
          }

          const argsChunk = toolCall?.function?.arguments;
          if (typeof argsChunk === 'string' && argsChunk.length > 0) {
            existing.argsBuffer += argsChunk;
          }

          toolCallsByIndex.set(index, existing);
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processBlock(block);
      boundary = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim().length > 0) {
    processBlock(buffer);
  }

  const functionCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => {
      const name = call.name.trim();
      if (!name) return null;

      const rawArgs = call.argsBuffer.trim();
      if (!rawArgs) {
        return { name };
      }
      try {
        return { name, args: JSON.parse(rawArgs) };
      } catch {
        return { name, args: { raw: rawArgs } };
      }
    })
    .filter((call): call is { name: string; args?: unknown } => Boolean(call));

  return {
    text,
    model,
    usage,
    functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
  };
}
