export interface ToolFunctionCall {
  name: string;
  args?: unknown;
}

export interface GatewayStreamChunk {
  text?: string;
  functionCalls?: ToolFunctionCall[];
}

export interface GatewayChat {
  sendMessageStream(input: { message: string }): Promise<AsyncIterable<GatewayStreamChunk>>;
}

export const LIVE_MODE_SUPPORTED = false;

interface ChatCreateInput {
  model: string;
  config?: {
    systemInstruction?: string;
    tools?: unknown[];
    responseMimeType?: string;
  };
}

interface GatewayApiRequest {
  operation: 'generateContent' | 'embedContent' | 'batchEmbedContents' | 'chatSend';
  payload: Record<string, unknown>;
}

interface GatewayErrorResponse {
  error?: string;
}

interface GatewayLiveSession {
  sendRealtimeInput(input: unknown): void;
  close(): void;
}

const API_PATH = '/api/gemini';

async function callGateway<T>(request: GatewayApiRequest): Promise<T> {
  const response = await fetch(API_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    let message = `Gemini gateway failed with status ${response.status}`;
    try {
      const errorData = (await response.json()) as GatewayErrorResponse;
      if (typeof errorData.error === 'string' && errorData.error.length > 0) {
        message = errorData.error;
      }
    } catch {
      // Ignore parse errors and keep generic status message.
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

export const ai = {
  models: {
    generateContent: (payload: Record<string, unknown>) =>
      callGateway<{ text?: string; functionCalls?: ToolFunctionCall[] }>({
        operation: 'generateContent',
        payload,
      }),
    embedContent: (payload: Record<string, unknown>) =>
      callGateway<{ embedding?: { values?: number[] } }>({
        operation: 'embedContent',
        payload,
      }),
    batchEmbedContents: (payload: Record<string, unknown>) =>
      callGateway<{ embeddings?: Array<{ values?: number[] }> }>({
        operation: 'batchEmbedContents',
        payload,
      }),
  },
  chats: {
    create: ({ model, config }: ChatCreateInput): GatewayChat => {
      const history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

      return {
        async sendMessageStream({ message }) {
          const chunk = await callGateway<GatewayStreamChunk>({
            operation: 'chatSend',
            payload: { model, config, history, message },
          });

          history.push({ role: 'user', parts: [{ text: message }] });
          if (chunk.text && chunk.text.length > 0) {
            history.push({ role: 'model', parts: [{ text: chunk.text }] });
          }

          return singleChunkStream(chunk);
        },
      };
    },
  },
  live: {
    connect: async (config?: unknown): Promise<GatewayLiveSession> => {
      void config;
      throw new Error(
        'Live audio mode is not available via server proxy yet. Use text mode or implement a server-side websocket bridge.',
      );
    },
  },
};

export const SYSTEM_INSTRUCTION = `Du bist der OpenClaw Gateway Proactive Agent – ein lernender, persönlicher Assistent mit temporalem Bewusstsein.

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
