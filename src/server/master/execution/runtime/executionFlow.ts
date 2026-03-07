import { aggregateDelegationResult } from '@/server/master/delegation/aggregator';
import { recoverDelegationQueue } from '@/server/master/delegation/recovery';
import { createPendingApprovalRequest } from '@/server/master/approvals/service';
import { resolveRuntimeApproval } from '@/server/master/execution/approvalPolicy';
import { buildCapabilityControl } from '@/server/master/execution/runtime/capabilityControl';
import { normalizeCapabilityOutput } from '@/server/master/execution/runtime/capabilityOutput';
import { executeCapabilityTask } from '@/server/master/execution/runtime/capabilityExecutor';
import { buildExecutionPlanWithModel } from '@/server/master/execution/runtime/executionPlan';
import { isMasterApprovalControlPlaneEnabled } from '@/server/master/featureFlags';
import { publishMasterUpdated } from '@/server/master/liveEvents';
import { parseJsonObject } from '@/server/master/execution/runtime/jsonParsing';
import type { RuntimeMode } from '@/server/master/execution/runtime/types';
import type { MasterOrchestrator } from '@/server/master/orchestrator';
import type { MasterRepository } from '@/server/master/repository';
import type { MasterWorkspaceBinding } from '@/server/master/workspaceScope';
import { verifyExecutionResult } from '@/server/master/verification';

export async function executeMasterRunFlow(input: {
  scope: MasterWorkspaceBinding;
  runId: string;
  repo: MasterRepository;
  orchestrator: MasterOrchestrator;
  nextStepSequence: (scope: MasterWorkspaceBinding, runId: string) => number;
}): Promise<void> {
  const { scope, runId, repo, orchestrator, nextStepSequence } = input;
  const publishRunState = () =>
    publishMasterUpdated({
      scope,
      resources: ['runs', 'metrics', 'run_detail'],
      runId,
    });
  const run = repo.getRun(scope, runId);
  if (!run) {
    throw new Error('Master run not found.');
  }
  if (
    run.status === 'COMPLETED' ||
    run.status === 'FAILED' ||
    run.status === 'CANCELLED' ||
    run.status === 'AWAITING_APPROVAL'
  ) {
    return;
  }

  recoverDelegationQueue(repo, scope, runId);

  let current = run;
  if (
    current.status === 'ANALYZING' ||
    current.status === 'IDLE' ||
    current.status === 'REFINING'
  ) {
    current = orchestrator.advanceRun(scope, runId, { progress: 12 });
  }

  const plan = await buildExecutionPlanWithModel(current.contract, scope);
  repo.appendStep(scope, runId, {
    runId,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    seq: nextStepSequence(scope, runId),
    phase: 'planning',
    status: 'done',
    input: current.contract,
    output: JSON.stringify(plan),
  });

  if (current.status === 'PLANNING') {
    current = orchestrator.advanceRun(scope, runId, { progress: 35 });
  }

  const mergedOutputs: string[] = [];
  const modeSet = new Set<RuntimeMode>([plan.source]);
  let degradedMode = false;

  for (const capability of plan.capabilities) {
    const latest = repo.getRun(scope, runId);
    if (!latest || latest.status === 'CANCELLED' || latest.status === 'FAILED') {
      return;
    }

    const control = buildCapabilityControl(capability, latest);
    const toolName =
      capability === 'system_ops'
        ? 'shell_execute'
        : capability === 'code_generation'
          ? 'write'
          : capability;
    const targetContext =
      control.filePath ??
      (capability === 'system_ops' ? (scope.workspaceCwd ?? scope.workspaceId) : 'create');
    const approval = resolveRuntimeApproval({
      repo,
      scope,
      actionType: control.actionType,
      fingerprint: control.fingerprint,
      requiresApproval: control.requiresApproval,
      toolName,
      host: 'gateway',
      targetContext,
    });

    if (approval.decision === 'awaiting_approval') {
      if (isMasterApprovalControlPlaneEnabled()) {
        createPendingApprovalRequest({
          repo,
          scope,
          runId,
          stepId: `approval-${capability}-${nextStepSequence(scope, runId)}`,
          actionType: approval.actionType,
          summary: `Approval required for ${capability}`,
          host: 'gateway',
          cwd: scope.workspaceCwd ?? null,
          resolvedPath: control.filePath ?? null,
          fingerprint: approval.fingerprint,
          riskLevel: control.requiresApproval ? 'high' : 'medium',
          toolName,
        });
      }
      repo.updateRun(scope, runId, {
        status: 'AWAITING_APPROVAL',
        pausedForApproval: true,
        lastError: approval.reason || `Approval required for ${approval.actionType}.`,
      });
      repo.appendStep(scope, runId, {
        runId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        seq: nextStepSequence(scope, runId),
        phase: `approval:${capability}`,
        status: 'blocked',
        input: latest.contract,
        output: approval.reason || `Approval required for ${approval.actionType}.`,
      });
      repo.appendAuditEvent(scope, {
        category: 'approval',
        action: 'approval_required',
        metadata: JSON.stringify({
          runId,
          capability,
          actionType: approval.actionType,
          fingerprint: approval.fingerprint,
        }),
      });
      return;
    }

    if (approval.decision === 'denied') {
      repo.updateRun(scope, runId, {
        status: 'REFINING',
        pausedForApproval: false,
        lastError: approval.reason || `Action denied: ${approval.actionType}.`,
      });
      publishRunState();
      repo.appendStep(scope, runId, {
        runId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        seq: nextStepSequence(scope, runId),
        phase: `approval:${capability}`,
        status: 'blocked',
        input: latest.contract,
        output: approval.reason || `Action denied: ${approval.actionType}.`,
      });
      repo.appendAuditEvent(scope, {
        category: 'approval',
        action: 'approval_denied',
        metadata: JSON.stringify({
          runId,
          capability,
          actionType: approval.actionType,
          fingerprint: approval.fingerprint,
        }),
      });
      return;
    }

    const step = repo.appendStep(scope, runId, {
      runId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      seq: nextStepSequence(scope, runId),
      phase: `delegation:${capability}`,
      status: 'running',
      input: latest.contract,
      output: null,
    });

    const delegated = await orchestrator.delegate(scope, runId, {
      capability,
      payload: JSON.stringify({ contract: latest.contract, stepId: step.id }),
      task: async () =>
        executeCapabilityTask({
          scope,
          run: latest,
          capability,
          stepId: step.id,
          repo,
          control,
          approvalBypass: control.requiresApproval && approval.decision === 'allowed',
        }),
    });

    if (!delegated.accepted) {
      repo.updateRun(scope, runId, {
        lastError: delegated.reason || `Delegation rejected for ${capability}.`,
      });
      publishRunState();
      repo.appendStep(scope, runId, {
        runId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        seq: nextStepSequence(scope, runId),
        phase: `policy:${capability}`,
        status: 'blocked',
        input: latest.contract,
        output: delegated.reason || 'policy_denied',
      });
      continue;
    }

    const events = repo.listDelegationEvents(scope, runId);
    const resultEvent = [...events]
      .reverse()
      .find((event) => event.jobId === delegated.jobId && event.type === 'result');
    const payload = resultEvent ? parseJsonObject(resultEvent.payload) : null;
    const output = String(payload?.output || '').trim();
    const confidenceValue = Number(payload?.confidence ?? 0.5);
    const aggregation = aggregateDelegationResult({
      output,
      confidence: Number.isFinite(confidenceValue) ? confidenceValue : 0.5,
    });
    const normalizedOutput = normalizeCapabilityOutput(capability, aggregation.mergedOutput);
    mergedOutputs.push(normalizedOutput);

    const taskMode = payload?.mode;
    if (taskMode === 'model' || taskMode === 'fallback') {
      modeSet.add(taskMode);
    }
    if (payload?.degradedMode) {
      degradedMode = true;
    }

    repo.updateRun(scope, runId, {
      progress: Math.min(80, (repo.getRun(scope, runId)?.progress || 0) + 18),
    });
    publishRunState();
    repo.appendStep(scope, runId, {
      runId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      seq: nextStepSequence(scope, runId),
      phase: `aggregation:${capability}`,
      status:
        aggregation.status === 'accepted'
          ? 'done'
          : aggregation.status === 'needs_rework'
            ? 'running'
            : 'error',
      input: latest.contract,
      output: normalizedOutput,
    });
  }

  if (current.status === 'DELEGATING') {
    current = orchestrator.advanceRun(scope, runId, { progress: 72 });
  }
  if (current.status === 'EXECUTING') {
    current = orchestrator.advanceRun(scope, runId, { progress: 85 });
  }

  const steps = repo.listSteps(scope, runId);
  const verificationReport = verifyExecutionResult({
    outputs: mergedOutputs,
    steps,
    expectedCapabilities: plan.capabilities,
  });
  const verificationPassed = verificationReport.status === 'passed';
  const executionMode: RuntimeMode = modeSet.has('model') && !degradedMode ? 'model' : 'fallback';
  const resultBundle = JSON.stringify(
    {
      runId,
      title: current.title,
      contract: current.contract,
      outputs: mergedOutputs,
      summary: mergedOutputs.join('\n\n'),
      executionMode,
      degradedMode,
      plan: {
        source: plan.source,
        rationale: plan.rationale,
        capabilities: plan.capabilities,
        verificationChecks: plan.verificationChecks,
        riskProfile: plan.riskProfile,
        requiresApproval: plan.requiresApproval,
      },
      verificationReport,
      completedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  repo.updateRun(scope, runId, {
    verificationPassed,
    resultBundle,
  });
  publishRunState();

  if (verificationReport.status === 'failed') {
    orchestrator.advanceRun(scope, runId, { failed: true, progress: 92 });
    repo.updateRun(scope, runId, {
      status: 'FAILED',
      lastError: verificationReport.summary,
    });
    publishRunState();
    repo.appendAuditEvent(scope, {
      category: 'verification',
      action: 'verification_failed',
      metadata: JSON.stringify({ runId, report: verificationReport }),
    });
    return;
  }

  if (verificationReport.status === 'needs_refinement') {
    orchestrator.advanceRun(scope, runId, { verificationPassed: false, progress: 92 });
    repo.updateRun(scope, runId, {
      status: 'REFINING',
      lastError: verificationReport.summary,
    });
    publishRunState();
    repo.appendAuditEvent(scope, {
      category: 'verification',
      action: 'verification_needs_refinement',
      metadata: JSON.stringify({ runId, report: verificationReport }),
    });
    return;
  }

  current = orchestrator.advanceRun(scope, runId, {
    verificationPassed: true,
    progress: 100,
  });
  if (current.status !== 'COMPLETED') {
    repo.updateRun(scope, runId, {
      status: 'COMPLETED',
    });
  }
  repo.updateRun(scope, runId, {
    progress: 100,
    pausedForApproval: false,
    lastError: null,
  });
  publishRunState();
  repo.appendAuditEvent(scope, {
    category: 'verification',
    action: 'verification_passed',
    metadata: JSON.stringify({ runId, report: verificationReport }),
  });
}
