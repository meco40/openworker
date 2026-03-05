import { NextResponse } from 'next/server';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import type { MasterRun } from '@/server/master/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const scope = resolveScopeFromRequest(request, userId);
    const run = getMasterRepository().getRun(scope, id);
    if (!run) {
      return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });
    }
    const steps = getMasterRepository().listSteps(scope, id);
    return NextResponse.json({ ok: true, run, steps });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get master run';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<Params> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      personaId?: string;
      workspaceId?: string;
      workspaceCwd?: string;
      status?: string;
      progress?: number;
      lastError?: string | null;
      pausedForApproval?: boolean;
      verificationPassed?: boolean;
      resultBundle?: string | null;
      title?: string;
      contract?: string;
    };
    const scope = resolveScopeFromRequest(request, userId, body);
    const patch: Partial<MasterRun> = {};
    if (body.status !== undefined) patch.status = body.status as MasterRun['status'];
    if (body.progress !== undefined) patch.progress = body.progress;
    if (body.lastError !== undefined) patch.lastError = body.lastError;
    if (body.pausedForApproval !== undefined) patch.pausedForApproval = body.pausedForApproval;
    if (body.verificationPassed !== undefined) patch.verificationPassed = body.verificationPassed;
    if (body.resultBundle !== undefined) patch.resultBundle = body.resultBundle;
    if (body.title !== undefined) patch.title = body.title;
    if (body.contract !== undefined) patch.contract = body.contract;

    const run = getMasterRepository().updateRun(scope, id, patch);
    if (!run) {
      return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to patch master run';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
