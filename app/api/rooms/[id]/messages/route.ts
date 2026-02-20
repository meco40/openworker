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
    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
    const rawBeforeSeq = url.searchParams.get('beforeSeq');
    let beforeSeq: number | undefined;
    if (rawBeforeSeq !== null) {
      const trimmed = rawBeforeSeq.trim();
      if (!/^\d+$/.test(trimmed)) {
        return NextResponse.json(
          { ok: false, error: 'beforeSeq must be a positive integer' },
          { status: 400 },
        );
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return NextResponse.json(
          { ok: false, error: 'beforeSeq must be a positive integer' },
          { status: 400 },
        );
      }
      beforeSeq = parsed;
    }

    const service = getRoomService();
    const messages = service.listMessages(userContext.userId, params.id, limit, beforeSeq);
    return NextResponse.json({ ok: true, messages });
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
    const body = (await request.json()) as { content?: string };
    const content = body.content?.trim();
    if (!content) {
      return NextResponse.json({ ok: false, error: 'content is required' }, { status: 400 });
    }

    const service = getRoomService();
    const msg = service.sendUserMessage(userContext.userId, params.id, content);
    return NextResponse.json({ ok: true, message: msg }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
