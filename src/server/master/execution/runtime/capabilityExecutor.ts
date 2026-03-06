import { toSummaryFromSearchResult } from '@/server/master/execution/runtime/capabilityOutput';
import { buildSystemCommand } from '@/server/master/execution/runtime/capabilityControl';
import { buildCodeGenerationContent } from '@/server/master/execution/runtime/codeGeneration';
import { runTool } from '@/server/master/execution/runtime/toolRunner';
import { isMasterGenericRuntimeEnabled } from '@/server/master/featureFlags';
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
  const { scope, run, capability, repo, control, approvalBypass, stepId } = input;
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

  if (!isMasterGenericRuntimeEnabled()) {
    return {
      output: `Generic runtime is disabled for capability ${capability}.`,
      confidence: 0.2,
      mode: 'fallback',
      degradedMode: true,
    };
  }

  if (capability === 'web_search') {
    try {
      const result = await runTool({
        scope,
        run,
        repo,
        stepId,
        approvalBypass,
        request: {
          toolName: 'web_search',
          actionType: 'web_search',
          fingerprint: 'web_search',
          requiresApproval: false,
          query: run.contract,
        },
      });
      if (result.status !== 'completed') {
        return {
          output: result.status === 'blocked' ? result.reason : result.summary,
          confidence: 0.25,
          mode: 'fallback',
          degradedMode: true,
        };
      }
      return {
        output: toSummaryFromSearchResult(result.details),
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
    const result = await runTool({
      scope,
      run,
      repo,
      stepId,
      approvalBypass,
      request: {
        toolName: 'write',
        actionType: control.actionType,
        fingerprint: control.fingerprint,
        requiresApproval: control.requiresApproval,
        path: filePath,
        content: generated.content,
      },
    });
    return {
      output:
        result.status === 'completed'
          ? `Wrote implementation draft to ${filePath}`
          : result.status === 'blocked'
            ? result.reason
            : result.summary,
      confidence: result.status === 'completed' ? (generated.mode === 'model' ? 0.86 : 0.74) : 0.25,
      mode: generated.mode,
      degradedMode: generated.degradedMode || result.status !== 'completed',
    };
  }

  if (capability === 'notes') {
    const result = await runTool({
      scope,
      run,
      repo,
      stepId,
      approvalBypass,
      request: {
        toolName: 'notes',
        actionType: 'notes',
        fingerprint: 'notes',
        requiresApproval: false,
        noteTitle: `Master note: ${run.title}`,
        noteContent: run.contract,
        noteTags: ['master', 'autonomous'],
      },
    });
    return {
      output:
        result.status === 'completed'
          ? result.output
          : result.status === 'blocked'
            ? result.reason
            : result.summary,
      confidence: result.status === 'completed' ? 0.8 : 0.25,
      mode: 'fallback',
      degradedMode: result.status !== 'completed',
    };
  }

  if (capability === 'reminders') {
    const result = await runTool({
      scope,
      run,
      repo,
      stepId,
      approvalBypass,
      request: {
        toolName: 'reminders',
        actionType: 'reminders',
        fingerprint: 'reminders',
        requiresApproval: false,
        noteTitle: `Follow-up: ${run.title}`,
        noteContent: run.contract,
        remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    return {
      output:
        result.status === 'completed'
          ? result.output
          : result.status === 'blocked'
            ? result.reason
            : result.summary,
      confidence: result.status === 'completed' ? 0.75 : 0.25,
      mode: 'fallback',
      degradedMode: result.status !== 'completed',
    };
  }

  const result = await runTool({
    scope,
    run,
    repo,
    stepId,
    approvalBypass,
    request: {
      toolName: 'shell_execute',
      actionType: control.actionType,
      fingerprint: control.fingerprint,
      requiresApproval: control.requiresApproval,
      command: control.command || buildSystemCommand(run.contract),
    },
  });
  return {
    output:
      result.status === 'completed'
        ? result.output
        : result.status === 'blocked'
          ? result.reason
          : result.summary,
    confidence: result.status === 'completed' ? 0.65 : 0.25,
    mode: 'fallback',
    degradedMode: result.status !== 'completed',
  };
}
