import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../src/server/auth/userContext';
import { getRoomService } from '../../../src/server/rooms/runtime';
import type { RoomGoalMode } from '../../../src/server/rooms/types';

export const runtime = 'nodejs';

function unauthorized() {
  return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  const userContext = await resolveRequestUserContext();
  if (!userContext) {
    return unauthorized();
  }

  const service = getRoomService();
  const rooms = service.listRooms(userContext.userId);
  return NextResponse.json({ ok: true, rooms });
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return unauthorized();
    }

    const body = (await request.json()) as {
      name?: string;
      description?: string;
      goalMode?: RoomGoalMode;
      routingProfileId?: string;
    };

    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    }

    const VALID_GOAL_MODES = new Set<string>(['planning', 'simulation', 'free']);
    const goalMode = VALID_GOAL_MODES.has(body.goalMode ?? '') ? body.goalMode! : 'planning';
    const routingProfileId = body.routingProfileId?.trim() || 'p1';
    const description = body.description?.trim() || null;

    const service = getRoomService();
    const room = service.createRoom(userContext.userId, { name, description, goalMode, routingProfileId });
    return NextResponse.json({ ok: true, room }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
