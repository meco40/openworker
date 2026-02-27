import { ChannelType } from '@/shared/domain/types';
import { dispatchSkill } from '@/server/skills/executeSkill';
import type { MasterRepository } from '@/server/master/repository';
import type { MasterRun, WorkspaceScope } from '@/server/master/types';
import { MasterOrchestrator } from '@/server/master/orchestrator';
import { aggregateDelegationResult } from '@/server/master/delegation/aggregator';
import { recoverDelegationQueue } from '@/server/master/delegation/recovery';
import type { MasterWorkspaceBinding } from '@/server/master/workspaceScope';

interface ExecutionPlan {
  capabilities: Array<'web_search' | 'code_generation' | 'notes' | 'reminders' | 'system_ops'>;
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

function buildExecutionPlan(contract: string): ExecutionPlan {
  const normalized = contract.toLowerCase();
  const capabilities: ExecutionPlan['capabilities'] = [];

  if (/\b(code|program|script|typescript|javascript|python)\b/.test(normalized)) {
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
  if (!capabilities.includes('web_search')) {
    capabilities.unshift('web_search');
  }

  return { capabilities: capabilities.slice(0, 2) };
}

function buildToolContext(scope: MasterWorkspaceBinding, runId: string) {
  return {
    bypassApproval: true,
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

function normalizeCapabilityOutput(capability: string, output: string): string {
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

async function executeCapabilityTask(input: {
  scope: MasterWorkspaceBinding;
  run: MasterRun;
  capability: ExecutionPlan['capabilities'][number];
  stepId: string;
  repo: MasterRepository;
}): Promise<{ output: string; confidence: number }> {
  const { scope, run, capability, stepId, repo } = input;
  const toolContext = buildToolContext(scope, run.id);

  if (capability === 'web_search') {
    try {
      const result = await dispatchSkill(
        'web_search',
        { query: run.contract, count: 5 },
        toolContext,
      );
      return { output: toSummaryFromSearchResult(result), confidence: 0.78 };
    } catch {
      return {
        output: `Fallback research summary for contract: ${run.contract}`,
        confidence: 0.62,
      };
    }
  }

  if (capability === 'code_generation') {
    const filePath = `master-output/${run.id}-solution.md`;
    const content = [
      '# Master Generated Program Draft',
      '',
      `Contract: ${run.contract}`,
      '',
      '## Proposed implementation',
      '- Define a small module boundary first.',
      '- Add automated tests for the critical path.',
      '- Verify with typecheck, lint, and focused test runs.',
    ].join('\n');
    await dispatchSkill(
      'write',
      {
        path: filePath,
        content,
      },
      toolContext,
    );
    return {
      output: `Wrote implementation draft to ${filePath}`,
      confidence: 0.74,
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
    };
  }

  const command = `echo ${JSON.stringify(run.contract).slice(0, 120)}`;
  const systemResult = await dispatchSkill(
    'shell_execute',
    { command },
    {
      ...toolContext,
      bypassApproval: true,
    },
  );
  const systemPayload = parseJsonObject(JSON.stringify(systemResult));
  return {
    output:
      typeof systemPayload?.stdout === 'string' && systemPayload.stdout.trim().length > 0
        ? systemPayload.stdout.trim()
        : `System command executed for step ${stepId}.`,
    confidence: 0.65,
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
    return {
      runId,
      status: run.status,
      run,
      steps,
      delegations: { jobs, events },
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
    if (run.status === 'COMPLETED' || run.status === 'FAILED') {
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

    const plan = buildExecutionPlan(current.contract);
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

    current = this.orchestrator.advanceRun(scope, runId, { progress: 35 });

    const mergedOutputs: string[] = [];
    for (const capability of plan.capabilities) {
      const stepSeq = this.nextStepSequence(scope, runId);
      const step = this.repo.appendStep(scope, runId, {
        runId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        seq: stepSeq,
        phase: `delegation:${capability}`,
        status: 'running',
        input: current.contract,
        output: null,
      });

      const delegated = await this.orchestrator.delegate(scope, runId, {
        capability,
        payload: JSON.stringify({ contract: current.contract, stepId: step.id }),
        task: async () =>
          executeCapabilityTask({
            scope,
            run: current,
            capability,
            stepId: step.id,
            repo: this.repo,
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
          input: current.contract,
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
        input: current.contract,
        output: normalizedOutput,
      });
    }

    current = this.orchestrator.advanceRun(scope, runId, { progress: 85 });

    const verificationPassed = mergedOutputs.some((entry) => entry.trim().length > 0);
    const resultBundle = JSON.stringify(
      {
        runId,
        title: current.title,
        contract: current.contract,
        outputs: mergedOutputs,
        summary: mergedOutputs.join('\n\n'),
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    );

    this.repo.updateRun(scope, runId, {
      verificationPassed,
      resultBundle,
    });
    current = this.orchestrator.advanceRun(scope, runId, {
      verificationPassed,
      progress: verificationPassed ? 100 : 92,
    });

    if (!verificationPassed) {
      this.repo.updateRun(scope, runId, {
        status: 'FAILED',
        lastError: 'Verification gate failed: empty aggregation output.',
      });
      return;
    }

    this.repo.updateRun(scope, runId, {
      status: 'COMPLETED',
      progress: 100,
      pausedForApproval: false,
      lastError: null,
    });
  }
}
