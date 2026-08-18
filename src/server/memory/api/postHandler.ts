import { NextResponse } from 'next/server';
import {
  MemoryRuntimeUnavailableError,
  ValidationError,
  getReadyMemoryService,
  parseRecallArgs,
  parseStoreArgs,
} from './shared';
import type { MemoryApiUserContext, MemoryPostBody } from './types';

export async function handleMemoryPost(request: Request, userContext: MemoryApiUserContext) {
  try {
    const body = (await request.json()) as MemoryPostBody;
    const fcName = String(body.fcName || '').trim();
    const args = body.args || {};
    const service = getReadyMemoryService();

    if (fcName === 'core_memory_store') {
      const parsed = parseStoreArgs(args);
      const node = await service.storeMemory({
        personaId: parsed.personaId,
        type: parsed.type,
        content: parsed.content,
        importance: parsed.importance,
        userId: userContext.userId,
      });
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
    const status =
      error instanceof ValidationError || error instanceof SyntaxError
        ? 400
        : error instanceof MemoryRuntimeUnavailableError
          ? 503
          : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
