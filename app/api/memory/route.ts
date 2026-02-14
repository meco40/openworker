import { NextResponse } from 'next/server';
import type { MemoryType } from '../../../core/memory/types';
import { getMemoryService } from '../../../src/server/memory/runtime';
import { resolveRequestUserContext } from '../../../src/server/auth/userContext';

export const runtime = 'nodejs';

interface MemoryPostBody {
  fcName?: string;
  args?: Record<string, unknown>;
}

class ValidationError extends Error {}

const ALLOWED_TYPES: MemoryType[] = [
  'fact',
  'preference',
  'avoidance',
  'lesson',
  'personality_trait',
  'workflow_pattern',
];

function parseStoreArgs(raw: Record<string, unknown>) {
  const personaId = parsePersonaId(raw.personaId);
  const type = String(raw.type || '').trim() as MemoryType;
  const content = String(raw.content || '').trim();
  const importanceRaw = Number(raw.importance ?? 3);
  const importance = Number.isFinite(importanceRaw)
    ? Math.min(5, Math.max(1, Math.round(importanceRaw)))
    : 3;

  if (!ALLOWED_TYPES.includes(type)) {
    throw new ValidationError('Invalid memory type.');
  }
  if (!content) {
    throw new ValidationError('content is required.');
  }
  return { personaId, type, content, importance };
}

function parseRecallArgs(raw: Record<string, unknown>) {
  const personaId = parsePersonaId(raw.personaId);
  const query = String(raw.query || '').trim();
  const limitRaw = Number(raw.limit ?? 3);
  const limit = Number.isFinite(limitRaw) ? Math.min(20, Math.max(1, Math.floor(limitRaw))) : 3;
  if (!query) {
    throw new ValidationError('query is required.');
  }
  return { personaId, query, limit };
}

function parsePersonaId(raw: unknown): string {
  const personaId = String(raw || '').trim();
  if (!personaId) {
    throw new ValidationError('personaId is required.');
  }
  return personaId;
}

function parseMemoryNodeId(raw: unknown): string {
  const nodeId = String(raw || '').trim();
  if (!nodeId) {
    throw new ValidationError('id is required.');
  }
  return nodeId;
}

function parseUpdateBody(raw: Record<string, unknown>): {
  personaId: string;
  id: string;
  type?: MemoryType;
  content?: string;
  importance?: number;
} {
  const personaId = parsePersonaId(raw.personaId);
  const id = parseMemoryNodeId(raw.id);

  const next: {
    personaId: string;
    id: string;
    type?: MemoryType;
    content?: string;
    importance?: number;
  } = { personaId, id };

  if (raw.type !== undefined) {
    const type = String(raw.type || '').trim() as MemoryType;
    if (!ALLOWED_TYPES.includes(type)) {
      throw new ValidationError('Invalid memory type.');
    }
    next.type = type;
  }

  if (raw.content !== undefined) {
    const content = String(raw.content || '').trim();
    if (!content) {
      throw new ValidationError('content must not be empty.');
    }
    next.content = content;
  }

  if (raw.importance !== undefined) {
    const importanceRaw = Number(raw.importance);
    const importance = Number.isFinite(importanceRaw)
      ? Math.min(5, Math.max(1, Math.round(importanceRaw)))
      : NaN;
    if (!Number.isFinite(importance)) {
      throw new ValidationError('importance must be numeric.');
    }
    next.importance = importance;
  }

  if (
    next.type === undefined &&
    next.content === undefined &&
    next.importance === undefined
  ) {
    throw new ValidationError('No fields to update.');
  }

  return next;
}

function parsePositiveInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseOptionalType(raw: unknown): MemoryType | undefined {
  const value = String(raw || '').trim();
  if (!value || value === 'all') {
    return undefined;
  }
  if (!ALLOWED_TYPES.includes(value as MemoryType)) {
    throw new ValidationError('Invalid memory type.');
  }
  return value as MemoryType;
}

function parseBulkBody(raw: Record<string, unknown>): {
  personaId: string;
  ids: string[];
  action: 'update' | 'delete';
  updates: { type?: MemoryType; importance?: number };
} {
  const personaId = parsePersonaId(raw.personaId);
  const idsRaw = Array.isArray(raw.ids) ? raw.ids : [];
  const ids = Array.from(
    new Set(idsRaw.map((id) => String(id || '').trim()).filter((id) => id.length > 0)),
  );
  if (ids.length === 0) {
    throw new ValidationError('ids must be a non-empty array.');
  }

  const actionRaw = String(raw.action || '').trim().toLowerCase();
  const action: 'update' | 'delete' = actionRaw === 'delete' ? 'delete' : 'update';

  const updates: { type?: MemoryType; importance?: number } = {};
  if (raw.type !== undefined) {
    updates.type = parseOptionalType(raw.type);
  }
  if (raw.importance !== undefined) {
    const importance = parsePositiveInt(raw.importance, 3, 1, 5);
    updates.importance = importance;
  }

  if (action === 'update' && updates.type === undefined && updates.importance === undefined) {
    throw new ValidationError('Bulk update requires at least one update field.');
  }

  return { personaId, ids, action, updates };
}

export async function GET(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    const personaId = parsePersonaId(url.searchParams.get('personaId'));
    const pageParam = url.searchParams.get('page');
    const pageSizeParam = url.searchParams.get('pageSize');
    const service = getMemoryService();

    if (pageParam !== null || pageSizeParam !== null) {
      const page = parsePositiveInt(pageParam, 1, 1, 1_000_000);
      const pageSize = parsePositiveInt(pageSizeParam, 25, 1, 200);
      const query = String(url.searchParams.get('query') || '').trim();
      const type = parseOptionalType(url.searchParams.get('type'));
      const result = await service.listPage(personaId, {
        page,
        pageSize,
        query: query || undefined,
        type,
      }, userContext.userId);
      return NextResponse.json({ ok: true, nodes: result.nodes, pagination: result.pagination });
    }

    return NextResponse.json({ ok: true, nodes: await service.snapshot(personaId, userContext.userId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load memory snapshot.';
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as MemoryPostBody;
    const fcName = String(body.fcName || '').trim();
    const args = body.args || {};
    const service = getMemoryService();

    if (fcName === 'core_memory_store') {
      const parsed = parseStoreArgs(args);
      const node = await service.store(
        parsed.personaId,
        parsed.type,
        parsed.content,
        parsed.importance,
        userContext.userId,
      );
      return NextResponse.json({ ok: true, result: { action: 'store', data: node } });
    }

    if (fcName === 'core_memory_recall') {
      const parsed = parseRecallArgs(args);
      const context = await service.recall(
        parsed.personaId,
        parsed.query,
        parsed.limit,
        userContext.userId,
      );
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

export async function PUT(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = parseUpdateBody(body);
    const service = getMemoryService();
    const node = await service.update(parsed.personaId, parsed.id, {
      type: parsed.type,
      content: parsed.content,
      importance: parsed.importance,
    }, userContext.userId);
    if (!node) {
      return NextResponse.json({ ok: false, error: 'Memory node not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, node });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    const status = error instanceof ValidationError || error instanceof SyntaxError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const url = new URL(request.url);
    const personaId = parsePersonaId(url.searchParams.get('personaId'));
    const nodeId = String(url.searchParams.get('id') || '').trim();
    const service = getMemoryService();

    if (nodeId) {
      const deleted = (await service.delete(personaId, nodeId, userContext.userId)) ? 1 : 0;
      return NextResponse.json({ ok: true, deleted });
    }

    const deleted = await service.deleteByPersona(personaId, userContext.userId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = parseBulkBody(body);
    const service = getMemoryService();

    if (parsed.action === 'delete') {
      const affected = await service.bulkDelete(parsed.personaId, parsed.ids, userContext.userId);
      return NextResponse.json({ ok: true, action: 'delete', affected });
    }

    const affected = await service.bulkUpdate(
      parsed.personaId,
      parsed.ids,
      parsed.updates,
      userContext.userId,
    );
    return NextResponse.json({ ok: true, action: 'update', affected });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    const status = error instanceof ValidationError || error instanceof SyntaxError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
