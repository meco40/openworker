import { NextResponse } from 'next/server';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

interface FeedbackBody {
  rating?: unknown;
  policy?: unknown;
  comment?: unknown;
}

export async function POST(request: Request, { params }: { params: Promise<Params> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = (await request.json()) as FeedbackBody;

    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json(
        { ok: false, error: 'rating must be an integer between 1 and 5' },
        { status: 400 },
      );
    }

    const policy = body.policy;
    if (policy !== 'safe' && policy !== 'balanced' && policy !== 'fast') {
      return NextResponse.json(
        { ok: false, error: "policy must be 'safe', 'balanced', or 'fast'" },
        { status: 400 },
      );
    }

    const comment =
      body.comment !== undefined && body.comment !== null ? String(body.comment).trim() : null;

    // Scope comes from URL query params (personaId, workspaceId), not from the POST body
    const scope = resolveScopeFromRequest(request, userId);
    const repo = getMasterRepository();

    const run = repo.getRun(scope, id);
    if (!run) {
      return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });
    }

    if (run.status !== 'COMPLETED') {
      return NextResponse.json(
        { ok: false, error: 'Feedback can only be submitted for completed runs' },
        { status: 422 },
      );
    }

    const feedback = repo.addFeedback(scope, {
      runId: id,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      rating,
      policy,
      comment: comment || null,
    });

    return NextResponse.json({ ok: true, feedback });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to submit feedback';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
