import { NextResponse } from 'next/server';
import { getMemoryService } from '@/server/memory/runtime';
import {
  DELETE_ALL_CONFIRM_TOKEN,
  ValidationError,
  isDeleteAllConfirmed,
  parsePersonaId,
} from './shared';
import type { MemoryApiUserContext } from './types';

export async function handleMemoryDelete(request: Request, userContext: MemoryApiUserContext) {
  try {
    const url = new URL(request.url);
    const personaId = parsePersonaId(url.searchParams.get('personaId'));
    const nodeId = String(url.searchParams.get('id') || '').trim();
    const service = getMemoryService();

    if (nodeId) {
      const deleted = (await service.delete(personaId, nodeId, userContext.userId)) ? 1 : 0;
      return NextResponse.json({ ok: true, deleted });
    }

    if (!isDeleteAllConfirmed(url.searchParams.get('confirm'))) {
      throw new ValidationError(
        `confirm=${DELETE_ALL_CONFIRM_TOKEN} is required to delete all memory entries for a persona.`,
      );
    }

    const deleted = await service.deleteByPersona(personaId, userContext.userId);
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    const status = error instanceof ValidationError ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
