import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getRoomService } from '../../../../../src/server/rooms/runtime';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return unauthorized();
    }

    const params = await context.params;
    const url = new URL(request.url);
    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    const rawBeforeSeq = url.searchParams.get('beforeSeq');
    const beforeSeq = rawBeforeSeq ? Number.parseInt(rawBeforeSeq, 10) : undefined;

    const service = getRoomService();
    const messages = service.listMessages(userContext.userId, params.id, limit, beforeSeq);
    return NextResponse.json({ ok: true, messages });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
