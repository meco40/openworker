import { aggregateDelegationResult } from '@/server/master/delegation/aggregator';
import { recoverDelegationQueue } from '@/server/master/delegation/recovery';
import { resolveRuntimeApproval } from '@/server/master/execution/approvalPolicy';
import { buildCapabilityControl } from '@/server/master/execution/runtime/capabilityControl';
import { normalizeCapabilityOutput } from '@/server/master/execution/runtime/capabilityOutput';
import { executeCapabilityTask } from '@/server/master/execution/runtime/capabilityExecutor';
import {
  buildExecutionPlanWithModel,
  buildLegacyVerificationReport,
} from '@/server/master/execution/runtime/executionPlan';
import { isFeatureEnabled } from '@/server/master/execution/runtime/featureFlags';
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

  const plan = await buildExecutionPlanWithModel(current.contract);
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
  const unifiedApprovalsEnabled = isFeatureEnabled('MASTER_UNIFIED_APPROVALS', true);
  const verificationV2Enabled = isFeatureEnabled('MASTER_VERIFY_GATE_V2', true);

  for (const capability of plan.capabilities) {
    const latest = repo.getRun(scope, runId);
    if (!latest || latest.status === 'CANCELLED' || latest.status === 'FAILED') {
      return;
    }

    const control = buildCapabilityControl(capability, latest);
    const approval = unifiedApprovalsEnabled
      ? resolveRuntimeApproval({
          repo,
          scope,
          actionType: control.actionType,
          fingerprint: control.fingerprint,
          requiresApproval: control.requiresApproval,
        })
      : {
          decision: 'allowed' as const,
          actionType: control.actionType,
          fingerprint: control.fingerprint,
          reason: 'Unified approvals disabled by feature flag.',
        };

    if (approval.decision === 'awaiting_approval') {
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
          approvalBypass: control.requiresApproval,
        }),
    });

    if (!delegated.accepted) {
      repo.updateRun(scope, runId, {
        lastError: delegated.reason || `Delegation rejected for ${capability}.`,
      });
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
  const verificationReport = verificationV2Enabled
    ? verifyExecutionResult({
        outputs: mergedOutputs,
        steps,
        expectedCapabilities: plan.capabilities,
      })
    : buildLegacyVerificationReport(mergedOutputs);
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

  if (verificationReport.status === 'failed') {
    orchestrator.advanceRun(scope, runId, { failed: true, progress: 92 });
    repo.updateRun(scope, runId, {
      status: 'FAILED',
      lastError: verificationReport.summary,
    });
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
  repo.appendAuditEvent(scope, {
    category: 'verification',
    action: 'verification_passed',
    metadata: JSON.stringify({ runId, report: verificationReport }),
  });
}
