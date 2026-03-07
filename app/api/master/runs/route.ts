import { NextResponse } from 'next/server';
import { publishMasterUpdated } from '@/server/master/liveEvents';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateRunBody {
  title?: string;
  contract?: string;
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
}

export async function GET(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const scope = resolveScopeFromRequest(request, userId);
    const runs = getMasterRepository().listRuns(scope);
    return NextResponse.json({ ok: true, runs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list master runs';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as CreateRunBody;
    if (!body.title || !body.contract) {
      return NextResponse.json(
        { ok: false, error: 'title and contract are required' },
        { status: 400 },
      );
    }

    const scope = resolveScopeFromRequest(request, userId, body);
    const run = getMasterRepository().createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: body.title,
      contract: body.contract,
    });
    publishMasterUpdated({
      scope,
      resources: ['runs', 'metrics', 'run_detail'],
      runId: run.id,
    });
    return NextResponse.json({ ok: true, run }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create master run';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
