import { NextResponse } from 'next/server';
import { getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import type { ApprovalDecision } from '@/server/master/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

interface ActionBody {
  personaId?: string;
  workspaceId?: string;
  workspaceCwd?: string;
  stepId?: string;
  actionType?: string;
  fingerprint?: string;
  decision?: ApprovalDecision;
}

function isApprovalDecision(value: string | undefined): value is ApprovalDecision {
  return value === 'approve_once' || value === 'approve_always' || value === 'deny';
}

export async function POST(request: Request, { params }: { params: Promise<Params> }) {
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = (await request.json()) as ActionBody;
    const actionType = String(body.actionType || '').trim();
    const stepId = String(body.stepId || '').trim();
    if (!actionType || !stepId) {
      return NextResponse.json(
        { ok: false, error: 'actionType and stepId are required' },
        { status: 400 },
      );
    }
    const scope = resolveScopeFromRequest(request, userId, body);
    const repo = getMasterRepository();
    const run = repo.getRun(scope, id);
    if (!run) {
      return NextResponse.json({ ok: false, error: 'Run not found' }, { status: 404 });
    }

    const fingerprint = String(body.fingerprint || `${actionType}:${stepId}`).trim();
    const storedRule = repo.getApprovalRule(scope, actionType, fingerprint);
    const effectiveDecision = isApprovalDecision(body.decision)
      ? body.decision
      : storedRule || undefined;

    if (!effectiveDecision) {
      repo.updateRun(scope, id, { status: 'AWAITING_APPROVAL', pausedForApproval: true });
      return NextResponse.json(
        {
          ok: false,
          approvalRequired: true,
          status: 'AWAITING_APPROVAL',
          actionType,
          fingerprint,
        },
        { status: 202 },
      );
    }

    if (effectiveDecision === 'approve_always') {
      repo.upsertApprovalRule(scope, actionType, fingerprint, 'approve_always');
    }

    if (effectiveDecision === 'deny') {
      const patched = repo.updateRun(scope, id, {
        status: 'REFINING',
        pausedForApproval: false,
        lastError: `Action denied: ${actionType}`,
      });
      return NextResponse.json({ ok: true, decision: effectiveDecision, run: patched });
    }

    const patched = repo.updateRun(scope, id, {
      status: 'EXECUTING',
      pausedForApproval: false,
      lastError: null,
    });
    return NextResponse.json({ ok: true, decision: effectiveDecision, run: patched });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply action decision';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
