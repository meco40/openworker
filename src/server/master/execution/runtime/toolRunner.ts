import { dispatchSkill } from '@/server/skills/executeSkill';
import { MasterActionLedgerService } from '@/server/master/execution/actionLedger';
import { buildIdempotencyKey } from '@/server/master/execution/idempotency';
import { executeSystemOperationWithRuntime } from '@/server/master/systemOps';
import { buildToolContext } from '@/server/master/execution/runtime/toolContext';
import type { MasterRepository } from '@/server/master/repository';
import type { MasterRun } from '@/server/master/types';
import type { MasterWorkspaceBinding } from '@/server/master/workspaceScope';
import type { ToolRunRequest, ToolRunResult } from '@/server/master/execution/runtime/types';

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
    const result = await dispatchSkill(
      'web_search',
      { query: request.query ?? run.contract, count: 5 },
      toolContext,
    );
    return {
      status: 'completed',
      output: JSON.stringify(result),
      details: result,
    };
  }

  if (request.toolName === 'notes') {
    const { ledger, idempotencyKey } = buildLedger({ repo, scope, run, stepId, request });
    const { result } = await ledger.executeExactlyOnce({
      scope,
      runId: run.id,
      stepId,
      actionType: request.actionType,
      idempotencyKey,
      execute: async () =>
        repo.createNote(scope, {
          title: request.noteTitle ?? `Master note: ${run.title}`,
          content: request.noteContent ?? run.contract,
          tags: request.noteTags ?? ['master', 'runtime'],
        }),
    });
    return {
      status: 'completed',
      output: `Stored note ${result.id}`,
      details: result,
    };
  }

  if (request.toolName === 'reminders') {
    const { ledger, idempotencyKey } = buildLedger({ repo, scope, run, stepId, request });
    const { result } = await ledger.executeExactlyOnce({
      scope,
      runId: run.id,
      stepId,
      actionType: request.actionType,
      idempotencyKey,
      execute: async () =>
        repo.createReminder(scope, {
          title: request.noteTitle ?? `Reminder: ${run.title}`,
          message: request.noteContent ?? run.contract,
          remindAt: request.remindAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          cronExpression: request.cronExpression ?? null,
          status: 'pending',
        }),
    });
    return {
      status: 'completed',
      output: `Created reminder ${result.id}`,
      details: result,
    };
  }

  if (request.toolName === 'write') {
    const { ledger, idempotencyKey } = buildLedger({ repo, scope, run, stepId, request });
    const { result } = await ledger.executeExactlyOnce({
      scope,
      runId: run.id,
      stepId,
      actionType: request.actionType,
      idempotencyKey,
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
    return {
      status: 'completed',
      output: `Wrote file ${request.path ?? `master-output/${run.id}-output.md`}`,
      details: result,
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
    const { result } = await ledger.executeExactlyOnce({
      scope,
      runId: run.id,
      stepId,
      actionType: request.actionType,
      idempotencyKey,
      execute: async () =>
        executeSystemOperationWithRuntime({
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
        }),
    });
    if (result.status !== 'executed') {
      return result.status === 'awaiting_approval'
        ? { status: 'approval_required', summary: result.output }
        : { status: 'blocked', reason: result.output };
    }
    return { status: 'completed', output: result.output, details: result };
  }

  return {
    status: 'blocked',
    reason: `Tool ${request.toolName} is not implemented in the Master runtime.`,
  };
}

export const executeMasterTool = runTool;
