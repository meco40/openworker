import { NextResponse } from 'next/server';
import { getMemoryService } from '@/server/memory/runtime';
import { MemoryVersionConflictError } from '@/server/memory/service';
import { ValidationError, parseUpdateBody } from './shared';
import type { MemoryApiUserContext } from './types';

export async function handleMemoryPut(request: Request, userContext: MemoryApiUserContext) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const parsed = parseUpdateBody(body);
    const service = getMemoryService();
    const node =
      parsed.restoreIndex !== undefined
        ? await service.restoreFromHistory(
            parsed.personaId,
            parsed.id,
            {
              restoreIndex: parsed.restoreIndex,
              expectedVersion: parsed.expectedVersion,
            },
            userContext.userId,
          )
        : await service.update(
            parsed.personaId,
            parsed.id,
            {
              type: parsed.type,
              content: parsed.content,
              importance: parsed.importance,
              expectedVersion: parsed.expectedVersion,
            },
            userContext.userId,
          );

    if (!node) {
      return NextResponse.json({ ok: false, error: 'Memory node not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, node });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    const status =
      error instanceof ValidationError || error instanceof SyntaxError
        ? 400
        : error instanceof MemoryVersionConflictError
          ? 409
          : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
