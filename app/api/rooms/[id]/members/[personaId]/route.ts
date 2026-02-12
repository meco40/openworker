import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../../src/server/auth/userContext';
import { getRoomService } from '../../../../../../src/server/rooms/runtime';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string; personaId: string }> };

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return unauthorized();
    }
    const params = await context.params;
    const service = getRoomService();
    const removed = service.removeMember(userContext.userId, params.id, params.personaId);
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return unauthorized();
    }

    const params = await context.params;
    const body = (await request.json()) as { paused?: boolean };
    if (typeof body.paused !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'paused must be a boolean' }, { status: 400 });
    }

    const service = getRoomService();
    const runtime = service.setMemberPaused(userContext.userId, params.id, params.personaId, body.paused);
    return NextResponse.json({ ok: true, runtime });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
