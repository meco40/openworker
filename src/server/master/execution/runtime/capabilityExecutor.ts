import { dispatchSkill } from '@/server/skills/executeSkill';
import { executeSystemOperationWithRuntime } from '@/server/master/systemOps';
import { buildSystemCommand } from '@/server/master/execution/runtime/capabilityControl';
import { toSummaryFromSearchResult } from '@/server/master/execution/runtime/capabilityOutput';
import { buildCodeGenerationContent } from '@/server/master/execution/runtime/codeGeneration';
import { parseJsonObject } from '@/server/master/execution/runtime/jsonParsing';
import { buildToolContext } from '@/server/master/execution/runtime/toolContext';
import { getMasterRuntimePersonaConfig } from '@/server/master/runtimePersona';
import type {
  Capability,
  CapabilityControl,
  CapabilityTaskResult,
} from '@/server/master/execution/runtime/types';
import type { MasterRepository } from '@/server/master/repository';
import type { MasterRun } from '@/server/master/types';
import type { MasterWorkspaceBinding } from '@/server/master/workspaceScope';

export async function executeCapabilityTask(input: {
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
  const runtimePersona = getMasterRuntimePersonaConfig({
    userId: scope.userId,
    personaId: scope.personaId,
  });

  const requiredTool =
    capability === 'web_search'
      ? 'web_search'
      : capability === 'code_generation'
        ? 'write'
        : capability === 'system_ops'
          ? 'shell_execute'
          : null;
  if (requiredTool && !runtimePersona.allowedToolFunctionNames.includes(requiredTool)) {
    return {
      output: `Capability ${capability} is not allowed because tool ${requiredTool} is not allowed.`,
      confidence: 0.2,
      mode: 'fallback',
      degradedMode: true,
    };
  }

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
    const generated = await buildCodeGenerationContent({
      run,
      filePath,
      scope: { userId: scope.userId, personaId: scope.personaId },
    });
    await dispatchSkill('write', { path: filePath, content: generated.content }, toolContext);
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
