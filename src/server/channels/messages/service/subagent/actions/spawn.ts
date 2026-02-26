import { SUBAGENT_DEFAULT_AGENT_ID } from '../constants';
import type { SpawnInputResult, ActionResult } from '../types';

export function parseSpawnInput(args: string[]): SpawnInputResult {
  if (args.length < 2) {
    return {
      agentId: '',
      task: '',
      error: 'Usage: /subagents spawn <agentId> <task> [--model <model>]',
    };
  }

  const agentId = args[0].trim() || SUBAGENT_DEFAULT_AGENT_ID;
  let modelOverride: string | undefined;
  const taskParts: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--model' && i + 1 < args.length) {
      modelOverride = args[i + 1].trim() || undefined;
      i += 1;
      continue;
    }
    taskParts.push(token);
  }
  const task = taskParts.join(' ').trim();
  if (!task) {
    return {
      agentId,
      task: '',
      error: 'Usage: /subagents spawn <agentId> <task> [--model <model>]',
    };
  }
  return { agentId, task, modelOverride };
}

export function formatSpawnSuccess(run: {
  runId: string;
  agentId: string;
  profileId?: string | null;
  profileName?: string | null;
  skillIds?: string[] | null;
  toolFunctionNames?: string[] | null;
  projectId?: string | null;
  workspacePath?: string | null;
  workspaceRelativePath?: string | null;
}): ActionResult {
  return {
    text: `Spawned subagent ${run.agentId} (${run.runId.slice(0, 8)}).`,
    payload: {
      status: 'accepted',
      action: 'spawn',
      runId: run.runId,
      agentId: run.agentId,
      profileId: run.profileId || null,
      profileName: run.profileName || null,
      skillIds: run.skillIds || [],
      toolFunctionNames: run.toolFunctionNames || [],
      projectId: run.projectId || null,
      workspacePath: run.workspacePath || null,
      workspaceRelativePath: run.workspaceRelativePath || null,
    },
  };
}

export function formatSpawnError(error: string): ActionResult {
  return {
    text: error,
    payload: {
      status: 'error',
      action: 'spawn',
      error,
    },
  };
}
