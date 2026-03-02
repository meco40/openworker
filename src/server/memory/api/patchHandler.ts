import { NextResponse } from 'next/server';
import { getMemoryService } from '@/server/memory/runtime';
import { ValidationError, parseBulkBody } from './shared';
import type { MemoryApiUserContext } from './types';

export async function handleMemoryPatch(request: Request, userContext: MemoryApiUserContext) {
  try {
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
