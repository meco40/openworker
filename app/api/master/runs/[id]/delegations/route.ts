import { NextResponse } from 'next/server';
import { publishMasterUpdated } from '@/server/master/liveEvents';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

interface DelegationBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  capability?: string;
  payload?: string;
  priority?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  maxAttempts?: number;
}

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const scope = resolveScopeFromRequest(request, userId);
    const jobs = getMasterRepository().listDelegationJobs(scope, id);
    const events = getMasterRepository().listDelegationEvents(scope, id);
    return NextResponse.json({ ok: true, jobs, events });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list delegations';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<Params> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await request.json()) as DelegationBody;
    if (!body.capability) {
      return NextResponse.json({ ok: false, error: 'capability is required' }, { status: 400 });
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const repo = getMasterRepository();
    const run = repo.getRun(scope, id);
    if (!run) {
      return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });
    }

    const job = repo.createDelegationJob(scope, {
      runId: id,
      capability: body.capability,
      payload: body.payload || '{}',
      status: 'queued',
      priority: body.priority || 'medium',
      maxAttempts: body.maxAttempts ?? 3,
      timeoutMs: body.timeoutMs ?? 120_000,
    });
    repo.appendDelegationEvent(scope, {
      jobId: job.id,
      runId: id,
      type: 'created',
      payload: JSON.stringify({ capability: body.capability }),
    });
    publishMasterUpdated({
      scope,
      resources: ['subagents', 'metrics'],
      runId: id,
    });
    return NextResponse.json({ ok: true, job }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create delegation';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
