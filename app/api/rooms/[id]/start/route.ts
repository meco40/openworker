import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getRoomService } from '../../../../../src/server/rooms/runtime';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return unauthorized();
    }

    const params = await context.params;
    const service = getRoomService();
    const room = service.updateRunState(userContext.userId, params.id, 'running');
    return NextResponse.json({ ok: true, room });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
