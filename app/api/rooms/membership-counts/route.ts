import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../src/server/auth/userContext';
import { getRoomService } from '../../../../src/server/rooms/runtime';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const service = getRoomService();
    const counts = service.listActiveRoomCountsByPersona(userContext.userId);
    return NextResponse.json({ ok: true, counts });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
