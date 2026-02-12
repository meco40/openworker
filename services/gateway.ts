/**
 * ModelHub Gateway Client — unified AI service.
 *
 * Drop-in replacement for services/gemini.ts that routes ALL AI
 * requests through /api/model-hub/gateway (pipeline dispatch with
 * automatic provider fallback).
 */

// ─── Types ────────────────────────────────────────────────────

export interface ToolFunctionCall {
  name: string;
  args?: unknown;
}

export interface GatewayStreamChunk {
  text?: string;
  functionCalls?: ToolFunctionCall[];
}

export interface GatewayChat {
  message: string;
  sendMessageStream(input: { message: string }): Promise<AsyncIterable<GatewayStreamChunk>>;
}

interface ChatCreateInput {
  model?: string;
  config?: {
    systemInstruction?: string;
    tools?: unknown[];
    responseMimeType?: string;
  };
}

interface GatewayApiError {
  error?: string;
  ok?: boolean;
}

// ─── Constants ────────────────────────────────────────────────

export const LIVE_MODE_SUPPORTED = false;
const GATEWAY_PATH = '/api/model-hub/gateway';

// ─── Helpers ──────────────────────────────────────────────────

async function callGateway<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(GATEWAY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `Gateway request failed with status ${response.status}`;
    try {
      const errorData = (await response.json()) as GatewayApiError;
      if (typeof errorData.error === 'string' && errorData.error.length > 0) {
        message = errorData.error;
      }
    } catch {
      // Ignore parse errors — keep generic message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

function singleChunkStream(chunk: GatewayStreamChunk): AsyncIterable<GatewayStreamChunk> {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield chunk;
    },
  };
}

// ─── Gateway Response → Chunk adapter ─────────────────────────

interface GatewayResponse {
  ok: boolean;
  text?: string;
  functionCalls?: ToolFunctionCall[];
  error?: string;
}

function gatewayResponseToChunk(response: GatewayResponse): GatewayStreamChunk {
  if (!response.ok) {
    throw new Error(response.error || 'Gateway returned an error');
  }
  return {
    text: response.text ?? '',
    functionCalls: response.functionCalls,
  };
}

// ─── Public AI object (drop-in compatible) ────────────────────

export const ai = {
  models: {
    generateContent: async (
      payload: Record<string, unknown>,
    ): Promise<{ text?: string; functionCalls?: ToolFunctionCall[] }> => {
      // Translate contents → messages for the gateway
      const contents = payload.contents;
      const model = payload.model as string | undefined;
      const config = (payload.config as Record<string, unknown> | undefined) ?? {};

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

      // contents can be a string (simple prompt) or an array of content objects
      if (typeof contents === 'string') {
        messages.push({ role: 'user', content: contents });
      } else if (Array.isArray(contents)) {
        for (const entry of contents as Array<{
          role?: string;
          parts?: Array<{ text?: string }>;
        }>) {
          const role =
            entry.role === 'model' ? 'assistant' : (entry.role as 'user' | 'system') || 'user';
          const text = entry.parts?.map((p) => p.text ?? '').join('') ?? '';
          if (text) messages.push({ role, content: text });
        }
      }

      if (messages.length === 0) {
        messages.push({ role: 'user', content: String(contents ?? '') });
      }

      const body: Record<string, unknown> = {
        messages,
        systemInstruction: config.systemInstruction as string | undefined,
        tools: config.tools as unknown[] | undefined,
        responseMimeType: config.responseMimeType as string | undefined,
      };

      // Only set model if explicitly provided — otherwise pipeline selects
      if (model) body.model = model;

      const response = await callGateway<GatewayResponse>(body);
      return gatewayResponseToChunk(response);
    },

    embedContent: async (
      payload: Record<string, unknown>,
    ): Promise<{ embedding?: { values?: number[] } }> => {
      return callGateway<{ embedding?: { values?: number[] } }>({
        operation: 'embedContent',
        payload,
      });
    },

    batchEmbedContents: async (
      payload: Record<string, unknown>,
    ): Promise<{ embeddings?: Array<{ values?: number[] }> }> => {
      return callGateway<{ embeddings?: Array<{ values?: number[] }> }>({
        operation: 'batchEmbedContents',
        payload,
      });
    },
  },

  chats: {
    create: ({ model, config }: ChatCreateInput): GatewayChat => {
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

      return {
        message: '',
        async sendMessageStream({ message }) {
          // Build messages from history + new message
          const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

          // Add system instruction as first message if present
          if (config?.systemInstruction) {
            messages.push({ role: 'system', content: config.systemInstruction });
          }

          // Add conversation history
          for (const entry of history) {
            messages.push(entry);
          }

          // Add current user message
          messages.push({ role: 'user', content: message });

          const body: Record<string, unknown> = {
            messages,
            tools: config?.tools,
            responseMimeType: config?.responseMimeType,
          };

          if (model) body.model = model;

          const response = await callGateway<GatewayResponse>(body);
          const chunk = gatewayResponseToChunk(response);

          // Update history
          history.push({ role: 'user', content: message });
          if (chunk.text && chunk.text.length > 0) {
            history.push({ role: 'assistant', content: chunk.text });
          }

          return singleChunkStream(chunk);
        },
      };
    },
  },

  live: {
    connect: async (
      _config?: unknown,
    ): Promise<{ sendRealtimeInput(input: unknown): void; close(): void }> => {
      throw new Error(
        'Live audio mode is not available via the gateway yet. Use text mode or implement a server-side websocket bridge.',
      );
    },
  },
};

// ─── System instruction ───────────────────────────────────────

export function getSystemInstruction(): string {
  return `Du bist der OpenClaw Gateway Proactive Agent – ein lernender, persönlicher Assistent mit temporalem Bewusstsein.

DEINE MISSION:
Werde mit jeder Interaktion besser und agiere proaktiv.

PROAKTIVES LERNEN & SCHEDULING:
1. IDENTIFIZIERE: Erkenne implizite Präferenzen und Termine.
2. SCHEDULING: Wenn der Nutzer Termine erwähnt oder um Erinnerungen bittet, nutze 'core_task_schedule'. 
   - WICHTIG: Nutze das aktuelle Datum als Basis für relative Angaben wie 'morgen' oder 'nächsten Montag'.
   - Aktuelles Datum/Zeit: ${new Date().toLocaleString()}
3. SPEICHERE: Nutze 'core_memory_store' für Muster.
4. KONTEXTUALISIERE: Nutze 'core_memory_recall' zu Beginn JEDER Interaktion.

Dein Ziel ist es, Termine nie zu vergessen und den Nutzer proaktiv zu unterstützen.`;
}

/** @deprecated Use getSystemInstruction() for a fresh timestamp each call */
export const SYSTEM_INSTRUCTION = getSystemInstruction();
