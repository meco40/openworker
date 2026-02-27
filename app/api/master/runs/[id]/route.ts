import { NextResponse } from 'next/server';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';

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
    const run = getMasterRepository().updateRun(scope, id, {
      status: body.status as never,
      progress: body.progress,
      lastError: body.lastError ?? undefined,
      pausedForApproval: body.pausedForApproval,
      verificationPassed: body.verificationPassed,
      resultBundle: body.resultBundle ?? undefined,
      title: body.title,
      contract: body.contract,
    });
    if (!run) {
      return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to patch master run';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
