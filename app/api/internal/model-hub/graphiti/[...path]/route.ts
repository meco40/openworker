import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import type { GatewayMessage } from '@/server/model-hub/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OpenAIMessageBody {
  role?: unknown;
  content?: unknown;
}

interface OpenAIChatBody {
  model?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  tools?: unknown;
  response_format?: unknown;
}

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

const GRAPHITI_PROFILE_ID = 'p1-graphiti';

function configuredToken(): string {
  return String(process.env.GRAPHITI_MODEL_HUB_TOKEN || '').trim();
}

function hasValidBearerToken(request: Request): boolean {
  const expected = configuredToken();
  if (!expected) return false;

  const authorization = request.headers.get('authorization') || '';
  const supplied = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
  if (!supplied || supplied.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const value = part as { text?: unknown; content?: unknown };
      if (typeof value.text === 'string') return value.text;
      if (typeof value.content === 'string') return value.content;
      return '';
    })
    .filter(Boolean)
    .join('');
}

function normalizeMessages(value: unknown): GatewayMessage[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const message = entry as OpenAIMessageBody;
    const role = message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return [];
    return [{ role, content: textFromContent(message.content) } satisfies GatewayMessage];
  });
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function responseFormatMimeType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const type = (value as { type?: unknown }).type;
  return type === 'json_object' || type === 'json_schema' ? 'application/json' : undefined;
}

function errorResponse(message: string, status: number): Response {
  return NextResponse.json({ error: { message, type: 'model_hub_gateway_error' } }, { status });
}

function toOpenAIResponse(result: {
  ok: boolean;
  text: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  functionCalls?: Array<{ name: string; args?: unknown }>;
  error?: string;
}): Response {
  if (!result.ok) return errorResponse(result.error || 'Model Hub dispatch failed.', 502);

  const toolCalls = (result.functionCalls || []).map((call, index) => ({
    id: `call_graphiti_${index + 1}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
    },
  }));

  return NextResponse.json({
    id: `chatcmpl-graphiti-${createHash('sha256')
      .update(`${Date.now()}\u0000${result.model}`)
      .digest('hex')
      .slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    ...(result.usage ? { usage: result.usage } : {}),
    system_fingerprint: `model-hub:${result.provider}`,
  });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!configuredToken()) {
    return errorResponse('Graphiti Model-Hub adapter token is not configured.', 503);
  }
  if (!hasValidBearerToken(request)) {
    return errorResponse('Unauthorized.', 401);
  }

  const { path } = await context.params;
  const endpoint = path.join('/');
  if (endpoint !== 'v1/chat/completions' && endpoint !== 'chat/completions') {
    return errorResponse('Only the chat completions endpoint is available.', 404);
  }

  let body: OpenAIChatBody;
  try {
    body = (await request.json()) as OpenAIChatBody;
  } catch {
    return errorResponse('Request body must be valid JSON.', 400);
  }

  const messages = normalizeMessages(body.messages);
  if (messages.length === 0) return errorResponse('messages must not be empty.', 400);

  const profileId = GRAPHITI_PROFILE_ID;
  const service = getModelHubService();
  const activeModels = service.listPipeline(profileId).filter((entry) => entry.status === 'active');
  const primaryModel = activeModels[0];
  if (!primaryModel) {
    return errorResponse(
      `No active Graphiti JSON model is configured in Model Hub profile ${profileId}.`,
      503,
    );
  }

  const result = await service.dispatchWithFallback(
    profileId,
    getModelHubEncryptionKey(),
    {
      messages,
      max_tokens: positiveNumber(body.max_tokens),
      temperature: positiveNumber(body.temperature),
      // Graphiti receives structured JSON. The selected profile is separate
      // from both the chat and embedding profiles, so its active priority
      // order is the only source of truth for this consumer.
      auditContext: { kind: 'knowledge-extraction' },
      tools: Array.isArray(body.tools) ? body.tools : undefined,
      responseMimeType: responseFormatMimeType(body.response_format),
      responseFormat: body.response_format,
    },
    { modelOverride: primaryModel.modelName },
  );

  return toOpenAIResponse(result);
}
