import { NextResponse } from 'next/server';
import { applyApprovalDecision } from '@/server/master/approvals/service';
import { isMasterApprovalControlPlaneEnabled } from '@/server/master/featureFlags';
import { getMasterExecutionRuntime, getMasterRepository } from '@/server/master/runtime';
import { resolveMasterUserId, resolveScopeFromRequest } from '@/server/master/http';
import type { ApprovalDecision } from '@/server/master/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

interface DecisionBody {
  workspaceId?: string;
  personaId?: string;
  workspaceCwd?: string;
  decision?: ApprovalDecision;
}

function isApprovalDecision(value: string | undefined): value is ApprovalDecision {
  return value === 'approve_once' || value === 'approve_always' || value === 'deny';
}

export async function POST(request: Request, { params }: { params: Promise<Params> }) {
  if (!isMasterApprovalControlPlaneEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'Master approval control plane is disabled.' },
      { status: 404 },
    );
  }
  const userId = await resolveMasterUserId();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = (await request.json()) as DecisionBody;
    if (!isApprovalDecision(body.decision)) {
      return NextResponse.json({ ok: false, error: 'decision is required' }, { status: 400 });
    }

    const { id } = await params;
    const scope = resolveScopeFromRequest(request, userId, body);
    const repo = getMasterRepository();
    const approvalRequest = applyApprovalDecision({
      repo,
      scope,
      requestId: id,
      decision: body.decision,
    });

    if (body.decision !== 'deny') {
      const runtime = getMasterExecutionRuntime();
      runtime.startBackground(scope, approvalRequest.runId);
    }

    const run = repo.getRun(scope, approvalRequest.runId);
    return NextResponse.json({ ok: true, approval: approvalRequest, approvalRequest, run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply approval decision';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
