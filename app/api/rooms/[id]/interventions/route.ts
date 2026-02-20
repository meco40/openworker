import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getRoomService } from '@/server/rooms/runtime';

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
    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 50;

    const service = getRoomService();
    const interventions = service.listInterventions(userContext.userId, params.id, limit);
    return NextResponse.json({ ok: true, interventions });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return unauthorized();
    }

    const params = await context.params;
    const body = (await request.json()) as { note?: string };
    const note = body.note?.trim();
    if (!note) {
      return NextResponse.json({ ok: false, error: 'note is required' }, { status: 400 });
    }

    const service = getRoomService();
    const intervention = service.addIntervention(userContext.userId, params.id, note);
    return NextResponse.json({ ok: true, intervention }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
