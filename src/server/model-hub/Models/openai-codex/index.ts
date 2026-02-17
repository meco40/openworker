import { extractCodexAccountId } from '../../codexAuth';
import { fetchWithTimeout } from '../shared/http';
import type {
  ConnectivityResult,
  FetchedModel,
  GatewayRequest,
  GatewayResponse,
  ProviderAdapter,
} from '../types';
import {
  readStoredAttachmentAsDataUrl,
  readStoredAttachmentBuffer,
} from '../../../channels/messages/attachments';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_RESPONSES_PATH = '/codex/responses';
const CODEX_REQUEST_TIMEOUT_MS = 60_000;
const OPENAI_CODEX_AUTH_CLAIM_HINT = 'chatgpt_account_id';
const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful coding assistant.';

const CODEX_MODEL_SEED = [
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
] as const;

type CodexReasoningEffort = NonNullable<GatewayRequest['reasoning_effort']> | 'minimal' | 'xhigh';

interface CodexUsagePayload {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  input_tokens_details?: {
    cached_tokens?: unknown;
  };
}

interface CodexResponsePayload {
  model?: unknown;
  status?: unknown;
  usage?: CodexUsagePayload;
  output?: unknown;
  error?: {
    message?: unknown;
  };
}

interface CodexSseEvent {
  type?: unknown;
  delta?: unknown;
  message?: unknown;
  code?: unknown;
  error?: {
    message?: unknown;
  };
  item?: unknown;
  response?: CodexResponsePayload;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapDefaultModels(defaultModels: string[]) {
  return defaultModels.map((id) => ({
    id,
    name: id,
    provider: 'openai-codex',
  }));
}

function mergeUniqueModels(primary: FetchedModel[], secondary: FetchedModel[]): FetchedModel[] {
  const seen = new Set<string>();
  const merged: FetchedModel[] = [];
  for (const model of [...primary, ...secondary]) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    merged.push(model);
  }
  return merged;
}

function buildCodexSeedModels(defaultModels: string[]): FetchedModel[] {
  const mergedDefaults = [...new Set<string>([...defaultModels, ...CODEX_MODEL_SEED])];
  return mapDefaultModels(mergedDefaults);
}

function resolveCodexProbeModel(
  preferredModel: string | undefined,
  defaultModels: string[],
): string {
  const normalizedPreferred = preferredModel?.trim();
  if (normalizedPreferred) return normalizedPreferred;
  const normalizedDefault = defaultModels.find((model) => model.trim().length > 0)?.trim();
  if (normalizedDefault) return normalizedDefault;
  return CODEX_MODEL_SEED[0];
}

function resolveCodexEndpoint(baseUrl = CODEX_BASE_URL): string {
  const normalized = (baseUrl || CODEX_BASE_URL).trim().replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}${CODEX_RESPONSES_PATH}`;
}

function buildCodexHeaders(secret: string): Record<string, string> {
  const accountId = extractCodexAccountId(secret);
  if (!accountId) {
    throw new Error(
      `OpenAI Codex access token is missing ${OPENAI_CODEX_AUTH_CLAIM_HINT} in JWT claims.`,
    );
  }

  return {
    Authorization: `Bearer ${secret}`,
    'chatgpt-account-id': accountId,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'pi',
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'User-Agent': 'clawtest-model-hub',
  };
}

function clampCodexReasoningEffort(
  modelId: string,
  effort: CodexReasoningEffort,
): CodexReasoningEffort {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (
    (normalizedModelId.startsWith('gpt-5.2') || normalizedModelId.startsWith('gpt-5.3')) &&
    effort === 'minimal'
  ) {
    return 'low';
  }
  if (normalizedModelId === 'gpt-5.1' && effort === 'xhigh') {
    return 'high';
  }
  if (normalizedModelId === 'gpt-5.1-codex-mini') {
    if (effort === 'high' || effort === 'xhigh') return 'high';
    if (effort === 'minimal') return 'medium';
  }
  return effort;
}

function isImageAttachment(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('image/');
}

function isTextAttachment(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return normalized.startsWith('text/') || normalized === 'application/json';
}

function toAttachmentFallbackText(name: string, mimeType: string, size: number): string {
  return `[Attachment: ${name} (${mimeType}, ${size} bytes)]`;
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

function buildCodexUserContentParts(
  message: GatewayRequest['messages'][number],
  includeBinaryAttachments: boolean,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  const trimmedContent = message.content.trim();
  if (trimmedContent) {
    parts.push({ type: 'input_text', text: trimmedContent });
  }

  for (const attachment of message.attachments || []) {
    const mimeType = attachment.mimeType || 'application/octet-stream';
    if (includeBinaryAttachments && isImageAttachment(mimeType)) {
      const dataUrl = readStoredAttachmentAsDataUrl(attachment);
      if (dataUrl) {
        parts.push({
          type: 'input_image',
          image_url: dataUrl,
        });
        continue;
      }
    }

    if (includeBinaryAttachments && isTextAttachment(mimeType)) {
      const snippet = readTextAttachmentSnippet(attachment);
      if (snippet) {
        parts.push({
          type: 'input_text',
          text: `Attachment ${attachment.name} (${mimeType}):\n${snippet}`,
        });
        continue;
      }
    }

    parts.push({
      type: 'input_text',
      text: toAttachmentFallbackText(attachment.name, mimeType, attachment.size),
    });
  }

  return parts;
}

function buildCodexInputMessages(
  messages: GatewayRequest['messages'],
): Array<Record<string, unknown>> {
  const converted: Array<Record<string, unknown>> = [];
  let assistantIndex = 0;
  const latestUserAttachmentIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user') continue;
      if ((message.attachments?.length || 0) > 0) return index;
    }
    return -1;
  })();

  for (const [index, message] of messages.entries()) {
    const content = message.content.trim();
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      const userContentParts = buildCodexUserContentParts(
        message,
        index === latestUserAttachmentIndex,
      );
      if (userContentParts.length === 0) continue;
      converted.push({
        role: 'user',
        content: userContentParts,
      });
      continue;
    }

    if (!content) continue;
    converted.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      id: `msg_${assistantIndex++}`,
      content: [{ type: 'output_text', text: content, annotations: [] }],
    });
  }

  return converted;
}

function buildCodexRequestBody(request: GatewayRequest): Record<string, unknown> {
  const systemParts = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);
  const instructions =
    request.systemInstruction?.trim() ||
    (systemParts.length > 0 ? systemParts.join('\n\n') : DEFAULT_CODEX_INSTRUCTIONS);

  const body: Record<string, unknown> = {
    model: request.model,
    store: false,
    stream: true,
    input: buildCodexInputMessages(request.messages),
    text: { verbosity: 'medium' },
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    instructions,
  };

  if (request.reasoning_effort) {
    body.reasoning = {
      effort: clampCodexReasoningEffort(
        request.model,
        request.reasoning_effort as CodexReasoningEffort,
      ),
      summary: 'auto',
    };
  }

  return body;
}

function extractTextFromCodexOutput(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const typedItem = item as { type?: unknown; content?: unknown };
    if (typedItem.type !== 'message' || !Array.isArray(typedItem.content)) continue;
    for (const contentPart of typedItem.content) {
      if (!contentPart || typeof contentPart !== 'object') continue;
      const typedPart = contentPart as { type?: unknown; text?: unknown; refusal?: unknown };
      if (typedPart.type === 'output_text' && typeof typedPart.text === 'string') {
        chunks.push(typedPart.text);
      } else if (typedPart.type === 'refusal' && typeof typedPart.refusal === 'string') {
        chunks.push(typedPart.refusal);
      }
    }
  }
  return chunks.join('').trim();
}

function mapCodexUsage(
  payload: CodexUsagePayload | undefined,
): GatewayResponse['usage'] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const inputTokens = toNumberOrNull(payload.input_tokens);
  const outputTokens = toNumberOrNull(payload.output_tokens);
  const totalTokens = toNumberOrNull(payload.total_tokens);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return undefined;

  const cachedTokens = toNumberOrNull(payload.input_tokens_details?.cached_tokens) ?? 0;
  const promptTokens = Math.max(0, (inputTokens ?? 0) - Math.max(0, cachedTokens));
  const completionTokens = Math.max(0, outputTokens ?? 0);
  const combinedTotal = Math.max(0, totalTokens ?? promptTokens + completionTokens);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: combinedTotal,
  };
}

function toCodexStreamError(event: CodexSseEvent): string | null {
  const explicit = toNonEmptyString(event.message);
  if (explicit) return explicit;
  const nested = toNonEmptyString(event.error?.message);
  if (nested) return nested;
  const code = toNonEmptyString(event.code);
  if (code) return code;
  return null;
}

function parseSseEvents(chunk: string): CodexSseEvent[] {
  const normalized = chunk.replace(/\r/g, '');
  const entries = normalized.split('\n\n');
  const events: CodexSseEvent[] = [];

  for (const entry of entries) {
    if (!entry.trim()) continue;
    const dataLines = entry
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as CodexSseEvent;
      events.push(parsed);
    } catch {
      continue;
    }
  }

  return events;
}

async function parseCodexSseResponse(
  response: Response,
): Promise<{ text: string; model?: string; usage?: GatewayResponse['usage'] }> {
  if (!response.body) {
    throw new Error('OpenAI Codex response stream was empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deltas: string[] = [];
  let fallbackText = '';
  let model: string | undefined;
  let usage: GatewayResponse['usage'] | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf('\n\n');
    if (boundary < 0) continue;

    const completeChunk = buffer.slice(0, boundary + 2);
    buffer = buffer.slice(boundary + 2);
    const events = parseSseEvents(completeChunk);

    for (const event of events) {
      const type = toNonEmptyString(event.type);
      if (!type) continue;

      if (type === 'error') {
        throw new Error(toCodexStreamError(event) || 'OpenAI Codex stream failed.');
      }

      if (type === 'response.failed') {
        throw new Error(
          toNonEmptyString(event.response?.error?.message) ||
            toCodexStreamError(event) ||
            'OpenAI Codex response failed.',
        );
      }

      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const delta = toStringOrNull(event.delta);
        if (delta !== null) deltas.push(delta);
      }

      if (type === 'response.output_item.done') {
        if (deltas.length > 0 || fallbackText) continue;
        const item = event.item;
        if (!item || typeof item !== 'object') continue;
        const typedItem = item as { type?: unknown; content?: unknown };
        if (typedItem.type !== 'message' || !Array.isArray(typedItem.content)) continue;
        const chunks: string[] = [];
        for (const contentPart of typedItem.content) {
          if (!contentPart || typeof contentPart !== 'object') continue;
          const typedPart = contentPart as { type?: unknown; text?: unknown; refusal?: unknown };
          if (typedPart.type === 'output_text' && typeof typedPart.text === 'string') {
            chunks.push(typedPart.text);
          } else if (typedPart.type === 'refusal' && typeof typedPart.refusal === 'string') {
            chunks.push(typedPart.refusal);
          }
        }
        fallbackText = chunks.join('').trim();
      }

      if (type === 'response.completed' || type === 'response.done') {
        const responsePayload = event.response;
        const modelName = toNonEmptyString(responsePayload?.model);
        if (modelName) model = modelName;
        usage = mapCodexUsage(responsePayload?.usage) ?? usage;
        if (deltas.length === 0 && !fallbackText) {
          fallbackText = extractTextFromCodexOutput(responsePayload?.output);
        }
      }
    }
  }

  if (buffer.trim()) {
    for (const event of parseSseEvents(buffer)) {
      const type = toNonEmptyString(event.type);
      if (!type) continue;
      if (type === 'error') {
        throw new Error(toCodexStreamError(event) || 'OpenAI Codex stream failed.');
      }
      if (type === 'response.failed') {
        throw new Error(
          toNonEmptyString(event.response?.error?.message) ||
            toCodexStreamError(event) ||
            'OpenAI Codex response failed.',
        );
      }
    }
  }

  const text = deltas.join('').trim() || fallbackText;
  return { text, model, usage };
}

function parseCodexHttpError(raw: string, status: number): string {
  if (!raw.trim()) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(raw) as {
      error?: string | { message?: unknown };
      message?: unknown;
      detail?: unknown;
    };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    if (
      parsed.error &&
      typeof parsed.error === 'object' &&
      typeof parsed.error.message === 'string' &&
      parsed.error.message.trim()
    ) {
      return parsed.error.message.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
  } catch {
    // fall through
  }
  return raw.trim();
}

async function dispatchCodexResponses(
  secret: string,
  request: GatewayRequest,
  options?: { signal?: AbortSignal },
): Promise<GatewayResponse> {
  const endpoint = resolveCodexEndpoint();
  let headers: Record<string, string>;

  try {
    headers = buildCodexHeaders(secret);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to build OpenAI Codex headers.';
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'openai-codex',
      error: message,
    };
  }

  const body = buildCodexRequestBody(request);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      CODEX_REQUEST_TIMEOUT_MS,
      options?.signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI Codex request failed.';
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'openai-codex',
      error: message,
    };
  }

  if (!response.ok) {
    const rawError = await response.text().catch(() => '');
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'openai-codex',
      error: parseCodexHttpError(rawError, response.status),
    };
  }

  try {
    const parsed = await parseCodexSseResponse(response);
    return {
      ok: true,
      text: parsed.text,
      model: parsed.model || request.model,
      provider: 'openai-codex',
      usage: parsed.usage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI Codex stream parse failed.';
    return {
      ok: false,
      text: '',
      model: request.model,
      provider: 'openai-codex',
      error: message,
    };
  }
}

async function testOpenAICodexConnectivity(params: {
  secret: string;
  defaultModels: string[];
  model?: string;
}): Promise<ConnectivityResult> {
  const probeModel = resolveCodexProbeModel(params.model, params.defaultModels);
  const probeRequest: GatewayRequest = {
    model: probeModel,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 16,
  };

  const result = await dispatchCodexResponses(params.secret, probeRequest);
  if (result.ok) {
    return {
      ok: true,
      message: `OpenAI Codex connectivity verified (codex responses reachable with model ${probeModel}).`,
    };
  }

  return {
    ok: false,
    message: `OpenAI Codex connectivity failed: ${result.error || 'Codex probe failed.'}`,
  };
}

const openAICodexProviderAdapter: ProviderAdapter = {
  id: 'openai-codex',
  fetchModels: async ({ provider }) => {
    const seedModels = buildCodexSeedModels(provider.defaultModels);
    return mergeUniqueModels(seedModels, []);
  },
  testConnectivity: ({ secret, provider }, options) =>
    testOpenAICodexConnectivity({
      secret,
      defaultModels: provider.defaultModels,
      model: options?.model,
    }),
  dispatchGateway: ({ secret }, request, options) =>
    dispatchCodexResponses(secret, request, { signal: options?.signal }),
};

export default openAICodexProviderAdapter;
