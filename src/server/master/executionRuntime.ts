import { ChannelType } from '@/shared/domain/types';
import { dispatchSkill } from '@/server/skills/executeSkill';
import { getModelHubEncryptionKey, getModelHubService } from '@/server/model-hub/runtime';
import type { MasterRepository } from '@/server/master/repository';
import type { MasterRun, WorkspaceScope } from '@/server/master/types';
import { MasterOrchestrator } from '@/server/master/orchestrator';
import { aggregateDelegationResult } from '@/server/master/delegation/aggregator';
import { recoverDelegationQueue } from '@/server/master/delegation/recovery';
import { resolveRuntimeApproval } from '@/server/master/execution/approvalPolicy';
import { verifyExecutionResult, type VerificationReport } from '@/server/master/verification';
import { executeSystemOperationWithRuntime } from '@/server/master/systemOps';
import type { MasterWorkspaceBinding } from '@/server/master/workspaceScope';

type Capability = 'web_search' | 'code_generation' | 'notes' | 'reminders' | 'system_ops';
type RuntimeMode = 'model' | 'fallback';

interface ExecutionPlan {
  capabilities: Capability[];
  rationale: string;
  verificationChecks: string[];
  riskProfile: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  source: RuntimeMode;
}

interface CapabilityControl {
  requiresApproval: boolean;
  actionType: string;
  fingerprint: string;
  filePath?: string;
  command?: string;
}

interface CapabilityTaskResult {
  output: string;
  confidence: number;
  mode: RuntimeMode;
  degradedMode: boolean;
}

function isFeatureEnabled(name: string, defaultEnabled = true): boolean {
  const fallback = defaultEnabled ? '1' : '0';
  const normalized = String(process.env[name] ?? fallback)
    .trim()
    .toLowerCase();
  if (!normalized) return defaultEnabled;
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}

function buildLegacyVerificationReport(outputs: string[]): VerificationReport {
  const hasOutput = outputs.some((entry) => String(entry || '').trim().length > 0);
  if (hasOutput) {
    return {
      status: 'passed',
      score: 100,
      summary: 'Legacy verification passed (non-empty output detected).',
      checks: [{ name: 'legacy_non_empty_output', passed: true, detail: 'Output is non-empty.' }],
    };
  }
  return {
    status: 'failed',
    score: 0,
    summary: 'Legacy verification failed (all outputs empty).',
    checks: [{ name: 'legacy_non_empty_output', passed: false, detail: 'All outputs are empty.' }],
  };
}

function parseJsonObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractJsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const direct = parseJsonObject(trimmed);
  if (direct) return direct;

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  return parseJsonObject(trimmed.slice(first, last + 1));
}

function normalizeCapabilities(input: unknown): Capability[] {
  const raw = Array.isArray(input) ? input : [];
  const normalized: Capability[] = [];
  for (const entry of raw) {
    const value = String(entry || '')
      .trim()
      .toLowerCase();
    if (
      value === 'web_search' ||
      value === 'code_generation' ||
      value === 'notes' ||
      value === 'reminders' ||
      value === 'system_ops'
    ) {
      if (!normalized.includes(value)) {
        normalized.push(value);
      }
    }
  }
  return normalized;
}

function buildFallbackExecutionPlan(contract: string): ExecutionPlan {
  const normalized = contract.toLowerCase();
  const capabilities: Capability[] = [];

  if (/\b(code|program|script|implement|implementation|module|function)\b/.test(normalized)) {
    capabilities.push('code_generation');
  }
  if (/\b(note|notiz|document|memo)\b/.test(normalized)) {
    capabilities.push('notes');
  }
  if (/\b(remind|reminder|erinner|cron|schedule)\b/.test(normalized)) {
    capabilities.push('reminders');
  }
  if (/\b(system|terminal|command|shell)\b/.test(normalized)) {
    capabilities.push('system_ops');
  }
  if (/\b(search|research|latest|docs|news|source|web)\b/.test(normalized)) {
    capabilities.unshift('web_search');
  }
  if (capabilities.length === 0) {
    capabilities.push('web_search');
  }

  const selected = capabilities.filter((entry, index) => capabilities.indexOf(entry) === index);
  return {
    capabilities: selected.slice(0, 3),
    rationale: 'Fallback planner selected capabilities from rule-based contract analysis.',
    verificationChecks: ['non_empty_outputs', 'structured_outputs', 'capability_phase_coverage'],
    riskProfile: selected.includes('system_ops')
      ? 'high'
      : selected.includes('code_generation')
        ? 'medium'
        : 'low',
    requiresApproval: selected.includes('system_ops') || selected.includes('code_generation'),
    source: 'fallback',
  };
}

async function buildExecutionPlanWithModel(contract: string): Promise<ExecutionPlan> {
  try {
    const response = await getModelHubService().dispatchWithFallback(
      'p1',
      getModelHubEncryptionKey(),
      {
        messages: [
          {
            role: 'system',
            content: [
              'You are a strict runtime planner for an autonomous execution engine.',
              'Return JSON only with keys:',
              '- capabilities: array of web_search|code_generation|notes|reminders|system_ops',
              '- rationale: string',
              '- verificationChecks: string[]',
              '- riskProfile: low|medium|high',
              '- requiresApproval: boolean',
              'Never return markdown fences.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Contract:\n${contract}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
        auditContext: { kind: 'worker_planner' },
      },
    );
    if (!response.ok) {
      throw new Error(response.error || 'planner model call failed');
    }
    const parsed = extractJsonObjectFromText(response.text);
    const capabilities = normalizeCapabilities(parsed?.capabilities);
    if (!capabilities.length) {
      throw new Error('planner model returned no supported capabilities');
    }
    const riskProfileRaw = String(parsed?.riskProfile || '').toLowerCase();
    const riskProfile: ExecutionPlan['riskProfile'] =
      riskProfileRaw === 'high' || riskProfileRaw === 'medium' || riskProfileRaw === 'low'
        ? (riskProfileRaw as ExecutionPlan['riskProfile'])
        : capabilities.includes('system_ops')
          ? 'high'
          : capabilities.includes('code_generation')
            ? 'medium'
            : 'low';
    const verificationChecks = Array.isArray(parsed?.verificationChecks)
      ? parsed.verificationChecks
          .map((entry) => String(entry || '').trim())
          .filter((entry) => entry.length > 0)
      : ['non_empty_outputs', 'structured_outputs', 'capability_phase_coverage'];
    return {
      capabilities: capabilities.slice(0, 3),
      rationale: String(parsed?.rationale || 'Model-generated runtime plan.'),
      verificationChecks,
      riskProfile,
      requiresApproval: Boolean(parsed?.requiresApproval),
      source: 'model',
    };
  } catch {
    return buildFallbackExecutionPlan(contract);
  }
}

function buildSystemCommand(contract: string): string {
  return `echo ${JSON.stringify(contract).slice(0, 120)}`;
}

function buildCapabilityControl(capability: Capability, run: MasterRun): CapabilityControl {
  if (capability === 'code_generation') {
    const filePath = `master-output/${run.id}-solution.md`;
    return {
      requiresApproval: true,
      actionType: 'file.write',
      fingerprint: 'file.write',
      filePath,
    };
  }
  if (capability === 'system_ops') {
    return {
      requiresApproval: true,
      actionType: 'shell.exec',
      fingerprint: 'shell.exec',
      command: buildSystemCommand(run.contract),
    };
  }
  return {
    requiresApproval: false,
    actionType: capability,
    fingerprint: capability,
  };
}

function buildToolContext(scope: MasterWorkspaceBinding, runId: string, bypassApproval = false) {
  return {
    bypassApproval,
    workspaceCwd: scope.workspaceCwd,
    conversationId: `master:${runId}`,
    userId: scope.userId,
    platform: ChannelType.WEBCHAT,
    externalChatId: `master:${scope.workspaceId}`,
  } as const;
}

function toSummaryFromSearchResult(input: unknown): string {
  const normalized = input as { provider?: string; results?: Array<Record<string, unknown>> };
  const rows = Array.isArray(normalized?.results) ? normalized.results : [];
  if (!rows.length) {
    return 'No web sources returned. Generated fallback summary from task contract.';
  }
  const top = rows.slice(0, 3).map((row, index) => {
    const title = String(row.title || row.url || `Result ${index + 1}`);
    const url = String(row.url || '').trim();
    const snippet = String(row.snippet || '').trim();
    return `${index + 1}. ${title}${url ? ` (${url})` : ''}${snippet ? ` - ${snippet}` : ''}`;
  });
  return top.join('\n');
}

function normalizeCapabilityOutput(capability: Capability, output: string): string {
  if (capability === 'code_generation') {
    return `Generated code artifact:\n${output}`;
  }
  if (capability === 'notes') {
    return `Created note:\n${output}`;
  }
  if (capability === 'reminders') {
    return `Created reminder:\n${output}`;
  }
  if (capability === 'system_ops') {
    return `System operation report:\n${output}`;
  }
  return output;
}

async function buildCodeGenerationContent(input: {
  run: MasterRun;
  filePath: string;
}): Promise<{ content: string; mode: RuntimeMode; degradedMode: boolean }> {
  const fallbackContent = [
    '# Master Generated Program Draft',
    '',
    `Contract: ${input.run.contract}`,
    '',
    '## Proposed implementation',
    '- Define a small module boundary first.',
    '- Add automated tests for the critical path.',
    '- Verify with typecheck, lint, and focused test runs.',
  ].join('\n');

  try {
    const response = await getModelHubService().dispatchWithFallback(
      'p1',
      getModelHubEncryptionKey(),
      {
        messages: [
          {
            role: 'system',
            content: [
              'You generate implementation drafts for coding tasks.',
              'Return JSON only with keys:',
              '- files: [{ path: string, content: string }]',
              '- patchPlan: string[]',
              '- testPlan: string[]',
              '- summary: string',
              'Do not return markdown fences.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Contract:\n${input.run.contract}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 1000,
        auditContext: { kind: 'worker_executor', taskId: input.run.id },
      },
    );
    if (!response.ok) {
      throw new Error(response.error || 'code generation model call failed');
    }
    const parsed = extractJsonObjectFromText(response.text);
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    const firstFile = files.find(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { content?: unknown }).content === 'string',
    ) as { path?: string; content: string } | undefined;
    const fileContent = String(firstFile?.content || '').trim();
    if (!fileContent) {
      throw new Error('model returned empty code generation content');
    }
    const summary = String(parsed?.summary || '').trim();
    return {
      content: summary.length > 0 ? `${fileContent}\n\n---\n\nSummary: ${summary}` : fileContent,
      mode: 'model',
      degradedMode: false,
    };
  } catch {
    return {
      content: fallbackContent,
      mode: 'fallback',
      degradedMode: true,
    };
  }
}

async function executeCapabilityTask(input: {
  scope: MasterWorkspaceBinding;
  run: MasterRun;
  capability: Capability;
  stepId: string;
  repo: MasterRepository;
  control: CapabilityControl;
  approvalBypass: boolean;
}): Promise<CapabilityTaskResult> {
  const { scope, run, capability, repo, control, approvalBypass } = input;
  const toolContext = buildToolContext(scope, run.id, approvalBypass);

  if (capability === 'web_search') {
    try {
      const result = await dispatchSkill(
        'web_search',
        { query: run.contract, count: 5 },
        toolContext,
      );
      return {
        output: toSummaryFromSearchResult(result),
        confidence: 0.78,
        mode: 'fallback',
        degradedMode: false,
      };
    } catch {
      return {
        output: `Fallback research summary for contract: ${run.contract}`,
        confidence: 0.62,
        mode: 'fallback',
        degradedMode: true,
      };
    }
  }

  if (capability === 'code_generation') {
    const filePath = control.filePath || `master-output/${run.id}-solution.md`;
    const generated = await buildCodeGenerationContent({ run, filePath });
    await dispatchSkill(
      'write',
      {
        path: filePath,
        content: generated.content,
      },
      toolContext,
    );
    return {
      output: `Wrote implementation draft to ${filePath}`,
      confidence: generated.mode === 'model' ? 0.86 : 0.74,
      mode: generated.mode,
      degradedMode: generated.degradedMode,
    };
  }

  if (capability === 'notes') {
    const note = repo.createNote(scope, {
      title: `Master note: ${run.title}`,
      content: run.contract,
      tags: ['master', 'autonomous'],
    });
    return {
      output: `Stored note ${note.id} (${note.title})`,
      confidence: 0.8,
      mode: 'fallback',
      degradedMode: false,
    };
  }

  if (capability === 'reminders') {
    const reminderAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const reminder = repo.createReminder(scope, {
      title: `Follow-up: ${run.title}`,
      message: run.contract,
      remindAt: reminderAt,
      cronExpression: null,
      status: 'pending',
    });
    return {
      output: `Created reminder ${reminder.id} for ${reminder.remindAt}`,
      confidence: 0.75,
      mode: 'fallback',
      degradedMode: false,
    };
  }

  const command = control.command || buildSystemCommand(run.contract);
  const systemResult = await executeSystemOperationWithRuntime({
    command,
    approved: approvalBypass,
    execute: async () => {
      const skillResult = await dispatchSkill(
        'shell_execute',
        { command },
        { ...toolContext, bypassApproval: approvalBypass },
      );
      const payload = parseJsonObject(JSON.stringify(skillResult)) || {};
      return {
        stdout: typeof payload.stdout === 'string' ? payload.stdout : '',
        stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
        exitCode:
          typeof payload.exitCode === 'number' ? payload.exitCode : Number(payload.exitCode || 0),
      };
    },
  });
  if (systemResult.status !== 'executed') {
    return {
      output: systemResult.output,
      confidence: 0.25,
      mode: 'fallback',
      degradedMode: true,
    };
  }
  return {
    output: systemResult.output,
    confidence: 0.65,
    mode: 'fallback',
    degradedMode: false,
  };
}

export interface MasterRunExportBundle {
  runId: string;
  status: string;
  run: MasterRun;
  steps: Array<Record<string, unknown>>;
  delegations: {
    jobs: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  };
  verificationReport: VerificationReport | null;
  executionMode: RuntimeMode | null;
  exportedAt: string;
}

export class MasterExecutionRuntime {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly repo: MasterRepository,
    private readonly orchestrator: MasterOrchestrator,
  ) {}

  isRunning(scope: WorkspaceScope, runId: string): boolean {
    return this.running.has(this.key(scope, runId));
  }

  startBackground(scope: MasterWorkspaceBinding, runId: string): boolean {
    const key = this.key(scope, runId);
    if (this.running.has(key)) return false;
    const promise = this.execute(scope, runId).finally(() => {
      this.running.delete(key);
    });
    this.running.set(key, promise);
    return true;
  }

  async executeNow(scope: MasterWorkspaceBinding, runId: string): Promise<MasterRun> {
    await this.execute(scope, runId);
    const run = this.repo.getRun(scope, runId);
    if (!run) {
      throw new Error('Master run not found.');
    }
    return run;
  }

  async waitForRun(scope: WorkspaceScope, runId: string): Promise<void> {
    const key = this.key(scope, runId);
    const pending = this.running.get(key);
    if (pending) {
      await pending;
    }
  }

  buildExportBundle(scope: WorkspaceScope, runId: string): MasterRunExportBundle {
    const run = this.repo.getRun(scope, runId);
    if (!run) {
      throw new Error('Run not found');
    }
    const steps = this.repo.listSteps(scope, runId).map((step) => ({ ...step }));
    const jobs = this.repo.listDelegationJobs(scope, runId).map((job) => ({ ...job }));
    const events = this.repo.listDelegationEvents(scope, runId).map((event) => ({ ...event }));
    const parsedBundle = run.resultBundle ? parseJsonObject(run.resultBundle) : null;
    return {
      runId,
      status: run.status,
      run,
      steps,
      delegations: { jobs, events },
      verificationReport: (parsedBundle?.verificationReport as VerificationReport) || null,
      executionMode:
        parsedBundle?.executionMode === 'model' || parsedBundle?.executionMode === 'fallback'
          ? (parsedBundle.executionMode as RuntimeMode)
          : null,
      exportedAt: new Date().toISOString(),
    };
  }

  private key(scope: WorkspaceScope, runId: string): string {
    return `${scope.userId}::${scope.workspaceId}::${runId}`;
  }

  private nextStepSequence(scope: WorkspaceScope, runId: string): number {
    const steps = this.repo.listSteps(scope, runId);
    if (!steps.length) return 1;
    return Math.max(...steps.map((step) => step.seq)) + 1;
  }

  private async execute(scope: MasterWorkspaceBinding, runId: string): Promise<void> {
    const run = this.repo.getRun(scope, runId);
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

    recoverDelegationQueue(this.repo, scope, runId);

    let current = run;
    if (
      current.status === 'ANALYZING' ||
      current.status === 'IDLE' ||
      current.status === 'REFINING'
    ) {
      current = this.orchestrator.advanceRun(scope, runId, { progress: 12 });
    }

    const plan = await buildExecutionPlanWithModel(current.contract);
    this.repo.appendStep(scope, runId, {
      runId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      seq: this.nextStepSequence(scope, runId),
      phase: 'planning',
      status: 'done',
      input: current.contract,
      output: JSON.stringify(plan),
    });

    if (current.status === 'PLANNING') {
      current = this.orchestrator.advanceRun(scope, runId, { progress: 35 });
    }

    const mergedOutputs: string[] = [];
    const modeSet = new Set<RuntimeMode>([plan.source]);
    let degradedMode = false;
    const unifiedApprovalsEnabled = isFeatureEnabled('MASTER_UNIFIED_APPROVALS', true);
    const verificationV2Enabled = isFeatureEnabled('MASTER_VERIFY_GATE_V2', true);

    for (const capability of plan.capabilities) {
      const latest = this.repo.getRun(scope, runId);
      if (!latest || latest.status === 'CANCELLED' || latest.status === 'FAILED') {
        return;
      }

      const control = buildCapabilityControl(capability, latest);
      const approval = unifiedApprovalsEnabled
        ? resolveRuntimeApproval({
            repo: this.repo,
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
        this.repo.updateRun(scope, runId, {
          status: 'AWAITING_APPROVAL',
          pausedForApproval: true,
          lastError: approval.reason || `Approval required for ${approval.actionType}.`,
        });
        this.repo.appendStep(scope, runId, {
          runId,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          seq: this.nextStepSequence(scope, runId),
          phase: `approval:${capability}`,
          status: 'blocked',
          input: latest.contract,
          output: approval.reason || `Approval required for ${approval.actionType}.`,
        });
        this.repo.appendAuditEvent(scope, {
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
        this.repo.updateRun(scope, runId, {
          status: 'REFINING',
          pausedForApproval: false,
          lastError: approval.reason || `Action denied: ${approval.actionType}.`,
        });
        this.repo.appendStep(scope, runId, {
          runId,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          seq: this.nextStepSequence(scope, runId),
          phase: `approval:${capability}`,
          status: 'blocked',
          input: latest.contract,
          output: approval.reason || `Action denied: ${approval.actionType}.`,
        });
        this.repo.appendAuditEvent(scope, {
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

      const stepSeq = this.nextStepSequence(scope, runId);
      const step = this.repo.appendStep(scope, runId, {
        runId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        seq: stepSeq,
        phase: `delegation:${capability}`,
        status: 'running',
        input: latest.contract,
        output: null,
      });

      const delegated = await this.orchestrator.delegate(scope, runId, {
        capability,
        payload: JSON.stringify({ contract: latest.contract, stepId: step.id }),
        task: async () =>
          executeCapabilityTask({
            scope,
            run: latest,
            capability,
            stepId: step.id,
            repo: this.repo,
            control,
            approvalBypass: control.requiresApproval,
          }),
      });

      if (!delegated.accepted) {
        this.repo.updateRun(scope, runId, {
          lastError: delegated.reason || `Delegation rejected for ${capability}.`,
        });
        this.repo.appendStep(scope, runId, {
          runId,
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          seq: this.nextStepSequence(scope, runId),
          phase: `policy:${capability}`,
          status: 'blocked',
          input: latest.contract,
          output: delegated.reason || 'policy_denied',
        });
        continue;
      }

      const events = this.repo.listDelegationEvents(scope, runId);
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

      this.repo.updateRun(scope, runId, {
        progress: Math.min(80, (this.repo.getRun(scope, runId)?.progress || 0) + 18),
      });
      this.repo.appendStep(scope, runId, {
        runId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        seq: this.nextStepSequence(scope, runId),
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
      current = this.orchestrator.advanceRun(scope, runId, { progress: 72 });
    }
    if (current.status === 'EXECUTING') {
      current = this.orchestrator.advanceRun(scope, runId, { progress: 85 });
    }

    const steps = this.repo.listSteps(scope, runId);
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

    this.repo.updateRun(scope, runId, {
      verificationPassed,
      resultBundle,
    });

    if (verificationReport.status === 'failed') {
      this.orchestrator.advanceRun(scope, runId, { failed: true, progress: 92 });
      this.repo.updateRun(scope, runId, {
        status: 'FAILED',
        lastError: verificationReport.summary,
      });
      this.repo.appendAuditEvent(scope, {
        category: 'verification',
        action: 'verification_failed',
        metadata: JSON.stringify({ runId, report: verificationReport }),
      });
      return;
    }

    if (verificationReport.status === 'needs_refinement') {
      this.orchestrator.advanceRun(scope, runId, { verificationPassed: false, progress: 92 });
      this.repo.updateRun(scope, runId, {
        status: 'REFINING',
        lastError: verificationReport.summary,
      });
      this.repo.appendAuditEvent(scope, {
        category: 'verification',
        action: 'verification_needs_refinement',
        metadata: JSON.stringify({ runId, report: verificationReport }),
      });
      return;
    }

    current = this.orchestrator.advanceRun(scope, runId, {
      verificationPassed: true,
      progress: 100,
    });
    if (current.status !== 'COMPLETED') {
      this.repo.updateRun(scope, runId, {
        status: 'COMPLETED',
      });
    }
    this.repo.updateRun(scope, runId, {
      progress: 100,
      pausedForApproval: false,
      lastError: null,
    });
    this.repo.appendAuditEvent(scope, {
      category: 'verification',
      action: 'verification_passed',
      metadata: JSON.stringify({ runId, report: verificationReport }),
    });
  }
}
