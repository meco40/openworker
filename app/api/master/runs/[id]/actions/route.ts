import { NextResponse } from 'next/server';
import {
  createPendingApprovalRequest,
  applyApprovalDecision,
} from '@/server/master/approvals/service';
import { isMasterApprovalControlPlaneEnabled } from '@/server/master/featureFlags';
import { publishMasterUpdated } from '@/server/master/liveEvents';
import { getMasterExecutionRuntime, getMasterRepository } from '@/server/master/runtime';
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
  approvalRequestId?: string;
  decision?: ApprovalDecision;
}

function isApprovalDecision(value: string | undefined): value is ApprovalDecision {
  return value === 'approve_once' || value === 'approve_always' || value === 'deny';
}

function isRunControlAction(actionType: string): boolean {
  return (
    actionType === 'run.start' ||
    actionType === 'run.tick' ||
    actionType === 'run.cancel' ||
    actionType === 'run.export'
  );
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

    if (isRunControlAction(actionType)) {
      const runtime = getMasterExecutionRuntime();
      if (actionType === 'run.start') {
        const started = runtime.startBackground(scope, id);
        const updated = repo.getRun(scope, id);
        if (updated) {
          publishMasterUpdated({
            scope,
            resources: ['runs', 'metrics', 'run_detail'],
            runId: updated.id,
          });
        }
        return NextResponse.json({
          ok: true,
          started,
          run: updated ? { ...updated, status: 'EXECUTING' } : updated,
        });
      }
      if (actionType === 'run.tick') {
        const updated = await runtime.executeNow(scope, id);
        publishMasterUpdated({
          scope,
          resources: ['runs', 'metrics', 'run_detail'],
          runId: updated.id,
        });
        return NextResponse.json({ ok: true, run: updated });
      }
      if (actionType === 'run.cancel') {
        const patched = repo.updateRun(scope, id, {
          status: 'CANCELLED',
          pausedForApproval: false,
          lastError: 'Run cancelled by operator.',
          cancelledAt: new Date().toISOString(),
          cancelReason: 'operator_cancel',
        });
        if (patched) {
          publishMasterUpdated({
            scope,
            resources: ['runs', 'metrics', 'run_detail'],
            runId: patched.id,
          });
        }
        return NextResponse.json({ ok: true, run: patched });
      }
      const exportBundle = runtime.buildExportBundle(scope, id);
      return NextResponse.json({ ok: true, exportBundle });
    }

    if (!isMasterApprovalControlPlaneEnabled()) {
      return NextResponse.json(
        { ok: false, error: 'Master approval control plane is disabled.' },
        { status: 404 },
      );
    }

    const fingerprint = String(body.fingerprint || actionType).trim() || actionType;
    const storedRule = repo.getApprovalRule(scope, actionType, fingerprint);
    const effectiveDecision = isApprovalDecision(body.decision)
      ? body.decision
      : storedRule || undefined;

    if (body.approvalRequestId && effectiveDecision) {
      const approval = applyApprovalDecision({
        repo,
        scope,
        requestId: body.approvalRequestId,
        decision: effectiveDecision,
      });
      if (effectiveDecision !== 'deny') {
        const runtime = getMasterExecutionRuntime();
        runtime.startBackground(scope, approval.runId);
      }
      const run = repo.getRun(scope, approval.runId);
      return NextResponse.json({ ok: true, approval, run });
    }

    if (!effectiveDecision) {
      const approvalRequest = createPendingApprovalRequest({
        repo,
        scope,
        runId: id,
        stepId,
        actionType,
        summary: `Approval required for ${actionType}`,
        host: 'gateway',
        cwd: body.workspaceCwd ?? null,
        resolvedPath: body.workspaceCwd ?? null,
        fingerprint,
        riskLevel: 'high',
      });
      repo.updateRun(scope, id, {
        status: 'AWAITING_APPROVAL',
        pausedForApproval: true,
        pendingApprovalActionType: actionType,
      });
      return NextResponse.json(
        {
          ok: false,
          approvalRequired: true,
          status: 'AWAITING_APPROVAL',
          actionType,
          fingerprint,
          approvalRequestId: approvalRequest.id,
        },
        { status: 202 },
      );
    }

    const approvalRequest = createPendingApprovalRequest({
      repo,
      scope,
      runId: id,
      stepId,
      actionType,
      summary: `Approval required for ${actionType}`,
      host: 'gateway',
      cwd: body.workspaceCwd ?? null,
      resolvedPath: body.workspaceCwd ?? null,
      fingerprint,
      riskLevel: 'high',
    });
    applyApprovalDecision({
      repo,
      scope,
      requestId: approvalRequest.id,
      decision: effectiveDecision,
    });

    if (effectiveDecision === 'deny') {
      const patched = repo.updateRun(scope, id, {
        status: 'REFINING',
        pausedForApproval: false,
        pendingApprovalActionType: null,
        lastError: `Action denied: ${actionType}`,
      });
      return NextResponse.json({ ok: true, decision: effectiveDecision, run: patched });
    }

    const patched = repo.updateRun(scope, id, {
      status: 'EXECUTING',
      pausedForApproval: false,
      pendingApprovalActionType: null,
      lastError: null,
    });
    const runtime = getMasterExecutionRuntime();
    const resumed = runtime.startBackground(scope, id);
    return NextResponse.json({ ok: true, decision: effectiveDecision, resumed, run: patched });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to apply action decision';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
