import { dispatchSkill } from '@/server/skills/executeSkill';
import { MasterActionLedgerService } from '@/server/master/execution/actionLedger';
import { buildIdempotencyKey } from '@/server/master/execution/idempotency';
import { executeSystemOperationWithRuntime, type SystemOpResult } from '@/server/master/systemOps';
import { buildToolContext } from '@/server/master/execution/runtime/toolContext';
import type { MasterRepository } from '@/server/master/repository';
import type { MasterRun } from '@/server/master/types';
import type { MasterWorkspaceBinding } from '@/server/master/workspaceScope';
import type { ToolRunRequest, ToolRunResult } from '@/server/master/execution/runtime/types';
import { bridgeMasterAction } from '@/server/world-model/services/masterActionBridge';

function buildLedger(input: {
  repo: MasterRepository;
  scope: MasterWorkspaceBinding;
  run: MasterRun;
  stepId: string;
  request: ToolRunRequest;
}) {
  const ledger = new MasterActionLedgerService(input.repo);
  const idempotencyKey = buildIdempotencyKey({
    runId: input.run.id,
    stepId: input.stepId,
    actionType: input.request.actionType,
    actionPayload: JSON.stringify(input.request),
  });
  return { ledger, idempotencyKey };
}

async function runCanonicalMasterAction<T>(input: {
  scope: MasterWorkspaceBinding;
  run: MasterRun;
  repo: MasterRepository;
  stepId: string;
  request: ToolRunRequest;
  execute: () => Promise<T>;
}): Promise<{ result?: T; succeeded: boolean; error?: string }> {
  const { ledger, idempotencyKey } = buildLedger(input);
  const bridged = await bridgeMasterAction<T>({
    userId: input.scope.userId,
    personaId: input.scope.personaId,
    workspaceId: input.scope.workspaceId,
    taskId: input.run.id,
    actionType: input.request.actionType,
    idempotencyKey,
    correlationId: input.run.id,
    run: async () => {
      const ledgerResult = await ledger.executeExactlyOnce({
        scope: input.scope,
        runId: input.run.id,
        stepId: input.stepId,
        actionType: input.request.actionType,
        idempotencyKey,
        execute: input.execute,
      });
      return {
        ok: true,
        result: ledgerResult.result,
        receipt: {
          providerId: 'master-ledger',
          target: input.request.toolName,
          timestamp: new Date().toISOString(),
          payload: { result: ledgerResult.result, replayed: ledgerResult.replayed },
        },
      };
    },
  });
  return { result: bridged.result, succeeded: bridged.succeeded, error: bridged.error };
}

export async function runTool(input: {
  scope: MasterWorkspaceBinding;
  run: MasterRun;
  repo: MasterRepository;
  stepId: string;
  request: ToolRunRequest;
  approvalBypass: boolean;
}): Promise<ToolRunResult> {
  const { scope, run, repo, request, approvalBypass, stepId } = input;
  const toolContext = buildToolContext(scope, run.id, approvalBypass);

  if (request.toolName === 'web_search') {
    const result = await runCanonicalMasterAction({
      scope,
      run,
      repo,
      stepId,
      request,
      execute: () =>
        dispatchSkill(
          'web_search',
          { query: request.query ?? run.contract, count: 5 },
          toolContext,
        ),
    });
    if (!result.succeeded || result.result === undefined) {
      return { status: 'blocked', reason: result.error ?? 'Web search action failed' };
    }
    return {
      status: 'completed',
      output: JSON.stringify(result.result),
      details: result.result,
    };
  }

  if (request.toolName === 'notes') {
    const result = await runCanonicalMasterAction({
      scope,
      run,
      repo,
      stepId,
      request,
      execute: async () =>
        repo.createNote(scope, {
          title: request.noteTitle ?? `Master note: ${run.title}`,
          content: request.noteContent ?? run.contract,
          tags: request.noteTags ?? ['master', 'runtime'],
        }),
    });
    if (!result.succeeded || !result.result) {
      return { status: 'blocked', reason: result.error ?? 'Note action failed' };
    }
    return {
      status: 'completed',
      output: `Stored note ${result.result.id}`,
      details: result.result,
    };
  }

  if (request.toolName === 'reminders') {
    const result = await runCanonicalMasterAction({
      scope,
      run,
      repo,
      stepId,
      request,
      execute: async () =>
        repo.createReminder(scope, {
          title: request.noteTitle ?? `Reminder: ${run.title}`,
          message: request.noteContent ?? run.contract,
          remindAt: request.remindAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          cronExpression: request.cronExpression ?? null,
          status: 'pending',
        }),
    });
    if (!result.succeeded || !result.result) {
      return { status: 'blocked', reason: result.error ?? 'Reminder action failed' };
    }
    return {
      status: 'completed',
      output: `Created reminder ${result.result.id}`,
      details: result.result,
    };
  }

  if (request.toolName === 'write') {
    const result = await runCanonicalMasterAction({
      scope,
      run,
      repo,
      stepId,
      request,
      execute: async () =>
        dispatchSkill(
          'write',
          {
            path: request.path ?? `master-output/${run.id}-output.md`,
            content: request.content ?? run.contract,
          },
          toolContext,
        ),
    });
    if (!result.succeeded || result.result === undefined) {
      return { status: 'blocked', reason: result.error ?? 'Write action failed' };
    }
    return {
      status: 'completed',
      output: `Wrote file ${request.path ?? `master-output/${run.id}-output.md`}`,
      details: result.result,
    };
  }

  if (request.toolName === 'shell_execute') {
    if (request.requiresApproval && !approvalBypass) {
      return {
        status: 'approval_required',
        summary: `Approval required for ${request.toolName}`,
      };
    }
    const { ledger, idempotencyKey } = buildLedger({ repo, scope, run, stepId, request });

    const worldModelResult = await bridgeMasterAction<SystemOpResult>({
      userId: scope.userId,
      personaId: scope.personaId,
      workspaceId: scope.workspaceId,
      taskId: run.id,
      actionType: request.actionType,
      idempotencyKey,
      run: async () => {
        const systemOpResult = await executeSystemOperationWithRuntime({
          command: request.command ?? '',
          approved: approvalBypass,
          execute: async () => {
            const skillResult = await dispatchSkill(
              'shell_execute',
              { command: request.command ?? '' },
              toolContext,
            );
            const payload = JSON.parse(JSON.stringify(skillResult)) as {
              stdout?: string;
              stderr?: string;
              exitCode?: number;
            };
            return payload;
          },
        });
        const ok = systemOpResult.status === 'executed';
        return {
          ok,
          error: ok ? undefined : systemOpResult.output,
          result: systemOpResult,
          receipt: {
            providerId: 'shell',
            target: request.command ?? '',
            timestamp: new Date().toISOString(),
            payload: {
              status: systemOpResult.status,
              exitCode: systemOpResult.status === 'executed' ? 0 : undefined,
              result: systemOpResult,
              outputPreview:
                systemOpResult.output?.slice(0, 500) ?? (ok ? undefined : systemOpResult.output),
            },
          },
        };
      },
    });

    const systemOpResult = worldModelResult.result;
    if (!systemOpResult) {
      return {
        status: 'blocked',
        reason: worldModelResult.error ?? 'Action result was not available for replay',
      };
    }

    if (!worldModelResult.succeeded || systemOpResult.status !== 'executed') {
      return systemOpResult.status === 'awaiting_approval'
        ? { status: 'approval_required', summary: systemOpResult.output }
        : {
            status: 'blocked',
            reason: systemOpResult.output ?? worldModelResult.error ?? 'Action failed',
          };
    }

    const { result } = await ledger.executeExactlyOnce({
      scope,
      runId: run.id,
      stepId,
      actionType: request.actionType,
      idempotencyKey,
      execute: async () => ({
        stdout: systemOpResult.output,
        stderr: '',
        exitCode: 0,
      }),
    });

    return { status: 'completed', output: result.stdout, details: result };
  }

  return {
    status: 'blocked',
    reason: `Tool ${request.toolName} is not implemented in the Master runtime.`,
  };
}

export const executeMasterTool = runTool;
