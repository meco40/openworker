import { NextResponse } from 'next/server';
import type { MemoryType } from '../../../core/memory/types';
import { getMemoryService } from '../../../src/server/memory/runtime';

export const runtime = 'nodejs';

interface MemoryPostBody {
  fcName?: string;
  args?: Record<string, unknown>;
}

class ValidationError extends Error {}

function parseStoreArgs(raw: Record<string, unknown>) {
  const type = String(raw.type || '').trim() as MemoryType;
  const content = String(raw.content || '').trim();
  const importanceRaw = Number(raw.importance ?? 3);
  const importance = Number.isFinite(importanceRaw)
    ? Math.min(5, Math.max(1, Math.round(importanceRaw)))
    : 3;

  const allowedTypes: MemoryType[] = [
    'fact',
    'preference',
    'avoidance',
    'lesson',
    'personality_trait',
    'workflow_pattern',
  ];

  if (!allowedTypes.includes(type)) {
    throw new ValidationError('Invalid memory type.');
  }
  if (!content) {
    throw new ValidationError('content is required.');
  }
  return { type, content, importance };
}

function parseRecallArgs(raw: Record<string, unknown>) {
  const query = String(raw.query || '').trim();
  const limitRaw = Number(raw.limit ?? 3);
  const limit = Number.isFinite(limitRaw) ? Math.min(20, Math.max(1, Math.floor(limitRaw))) : 3;
  if (!query) {
    throw new ValidationError('query is required.');
  }
  return { query, limit };
}

export async function GET() {
  try {
    const service = getMemoryService();
    return NextResponse.json({ ok: true, nodes: service.snapshot() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load memory snapshot.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as MemoryPostBody;
    const fcName = String(body.fcName || '').trim();
    const args = body.args || {};
    const service = getMemoryService();

    if (fcName === 'core_memory_store') {
      const parsed = parseStoreArgs(args);
      const node = await service.store(parsed.type, parsed.content, parsed.importance);
      return NextResponse.json({ ok: true, result: { action: 'store', data: node } });
    }

    if (fcName === 'core_memory_recall') {
      const parsed = parseRecallArgs(args);
      const context = await service.recall(parsed.query, parsed.limit);
      return NextResponse.json({ ok: true, result: { action: 'recall', data: context } });
    }

    return NextResponse.json(
      { ok: false, error: `Unsupported function call: ${fcName || 'undefined'}` },
      { status: 400 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    const status = error instanceof ValidationError || error instanceof SyntaxError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
