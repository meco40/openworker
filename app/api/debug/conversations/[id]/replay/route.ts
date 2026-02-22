import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '@/server/auth/userContext';
import { getReplayService } from '@/server/debug/replayService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await resolveRequestUserContext();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body: { fromSeq?: unknown; modelOverride?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const fromSeq = Number(body.fromSeq);
  if (!Number.isInteger(fromSeq) || fromSeq < 1) {
    return NextResponse.json(
      { ok: false, error: 'fromSeq must be an integer >= 1' },
      { status: 400 },
    );
  }

  const modelOverride = typeof body.modelOverride === 'string' ? body.modelOverride : undefined;

  try {
    const newConversationId = await getReplayService().replayFrom(id, fromSeq, modelOverride);
    return NextResponse.json({ ok: true, newConversationId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Replay failed';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
