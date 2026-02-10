import { GoogleGenAI } from '@google/genai';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

type Operation = 'generateContent' | 'embedContent' | 'batchEmbedContents' | 'chatSend';

interface RequestBody {
  operation: Operation;
  payload: Record<string, unknown>;
}

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
  if (!key) {
    throw new Error('Missing GEMINI_API_KEY on server.');
  }
  return key;
}

function extractFunctionCalls(result: unknown): Array<{ name: string; args?: unknown }> {
  const typed = result as {
    functionCalls?: Array<{ name: string; args?: unknown }>;
    candidates?: Array<{ content?: { parts?: Array<{ functionCall?: { name: string; args?: unknown } }> } }>;
  };

  if (Array.isArray(typed.functionCalls) && typed.functionCalls.length > 0) {
    return typed.functionCalls;
  }

  const parts = typed.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.functionCall)
    .filter((call): call is { name: string; args?: unknown } => Boolean(call && call.name));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const ai = new GoogleGenAI({ apiKey: getApiKey() });

    switch (body.operation) {
      case 'generateContent': {
        const result = await (ai.models as any).generateContent(body.payload);
        return NextResponse.json({
          text: result?.text ?? '',
          functionCalls: extractFunctionCalls(result),
        });
      }
      case 'embedContent': {
        const result = await (ai.models as any).embedContent(body.payload);
        return NextResponse.json(result);
      }
      case 'batchEmbedContents': {
        const modelsObj = ai.models as any;
        if (typeof modelsObj.batchEmbedContents !== 'function') {
          return NextResponse.json({ embeddings: [] });
        }
        const result = await modelsObj.batchEmbedContents(body.payload);
        return NextResponse.json(result);
      }
      case 'chatSend': {
        const model = String(body.payload.model ?? '');
        const config = (body.payload.config as Record<string, unknown> | undefined) ?? {};
        const history = (body.payload.history as unknown[]) ?? [];
        const message = String(body.payload.message ?? '');
        const contents = [
          ...history,
          { role: 'user', parts: [{ text: message }] },
        ];

        const result = await (ai.models as any).generateContent({
          model,
          contents,
          config,
        });

        return NextResponse.json({
          text: result?.text ?? '',
          functionCalls: extractFunctionCalls(result),
        });
      }
      default:
        return NextResponse.json({ error: 'Unsupported operation.' }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown gateway error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
