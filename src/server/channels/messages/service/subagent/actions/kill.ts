import {
  abortSubagentRun,
  listActiveSubagentRuns,
  markSubagentRunKilled,
} from '@/server/agents/subagentRegistry';
import type { ActionResult } from '../types';

export function executeKillAllAction(conversationId: string): ActionResult {
  const activeRuns = listActiveSubagentRuns(conversationId);
  let killed = 0;
  for (const run of activeRuns) {
    const wasRunning = abortSubagentRun(run.runId, 'Subagent run was stopped by requester.');
    if (wasRunning || run.status === 'running') {
      killed += 1;
    }
  }
  return {
    text:
      killed > 0 ? `Killed ${killed} subagent${killed === 1 ? '' : 's'}.` : 'No running subagents.',
    payload: {
      status: 'ok',
      action: 'kill',
      target: 'all',
      killed,
    },
  };
}

export function executeKillTargetAction(
  target: string,
  resolved: { run: { runId: string; agentId: string } | null; error?: string },
): ActionResult {
  if (!resolved.run) {
    return {
      text: resolved.error || 'Unknown subagent target.',
      payload: {
        status: 'error',
        action: 'kill',
        target,
        error: resolved.error || 'Unknown subagent target.',
      },
    };
  }
  const wasRunning = abortSubagentRun(resolved.run.runId, 'Subagent run was stopped by requester.');
  if (!wasRunning) {
    markSubagentRunKilled(resolved.run.runId, 'Subagent run was stopped by requester.');
  }
  return {
    text: `Killed ${resolved.run.agentId} (${resolved.run.runId.slice(0, 8)}).`,
    payload: {
      status: 'ok',
      action: 'kill',
      target,
      runId: resolved.run.runId,
    },
  };
}

export function formatKillMissingTargetError(): ActionResult {
  return {
    text: 'Usage: /subagents kill <id|#|all>',
    payload: {
      status: 'error',
      action: 'kill',
      error: 'Missing target.',
    },
  };
}
