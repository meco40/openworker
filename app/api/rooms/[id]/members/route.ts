import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getRoomService } from '../../../../../src/server/rooms/runtime';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ id: string }> };

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return unauthorized();
    }

    const params = await context.params;
    const roomId = params.id;
    const body = (await request.json()) as {
      personaId?: string;
      roleLabel?: string;
      turnPriority?: number;
      modelOverride?: string | null;
    };

    if (!body.personaId?.trim()) {
      return NextResponse.json({ ok: false, error: 'personaId is required' }, { status: 400 });
    }

    const roleLabel = body.roleLabel?.trim() || 'Member';
    const service = getRoomService();
    const member = service.addMember(userContext.userId, roomId, {
      personaId: body.personaId.trim(),
      roleLabel,
      turnPriority: body.turnPriority,
      modelOverride: body.modelOverride ?? null,
    });

    return NextResponse.json({ ok: true, member }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
