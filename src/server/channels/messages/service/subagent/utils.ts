import { listSubagentRunsForConversation } from '@/server/agents/subagentRegistry';
import { SUBAGENT_RECENT_MINUTES } from './constants';
import type { ResolvedToolContext, SubagentAction } from '../types';

export function resolveToolFunctionName(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return '';
  const entry = tool as { function?: { name?: unknown }; name?: unknown };
  if (typeof entry.function?.name === 'string') return entry.function.name;
  if (typeof entry.name === 'string') return entry.name;
  return '';
}

export function filterToolContextForSubagent(
  toolContext: ResolvedToolContext,
  allowedFunctionNames?: string[],
): ResolvedToolContext {
  const allowedSet =
    Array.isArray(allowedFunctionNames) && allowedFunctionNames.length > 0
      ? new Set(
          allowedFunctionNames
            .map((value) => String(value || '').trim())
            .filter((value) => value.length > 0),
        )
      : null;

  const filteredTools = toolContext.tools.filter((tool) => {
    const functionName = resolveToolFunctionName(tool);
    return functionName !== 'subagents';
  });

  const installedFunctionNames = new Set(toolContext.installedFunctionNames);
  installedFunctionNames.delete('subagents');

  const functionToSkillId = new Map(toolContext.functionToSkillId);
  functionToSkillId.delete('subagents');

  if (!allowedSet || allowedSet.size === 0) {
    return {
      tools: filteredTools,
      installedFunctionNames,
      functionToSkillId,
    };
  }

  const toolsByAllowList = filteredTools.filter((tool) =>
    allowedSet.has(resolveToolFunctionName(tool)),
  );
  const installedByAllowList = new Set(
    [...installedFunctionNames].filter((functionName) => allowedSet.has(functionName)),
  );
  const functionMapByAllowList = new Map(
    [...functionToSkillId.entries()].filter(([functionName]) => allowedSet.has(functionName)),
  );

  return {
    tools: toolsByAllowList,
    installedFunctionNames: installedByAllowList,
    functionToSkillId: functionMapByAllowList,
  };
}

export function resolveSubagentTarget(
  conversationId: string,
  rawTarget: string,
): { run: import('@/server/agents/subagentRegistry').SubagentRunRecord | null; error?: string } {
  const target = rawTarget.trim();
  if (!target) {
    return { run: null, error: 'Missing subagent target.' };
  }

  const runs = listSubagentRunsForConversation(conversationId, SUBAGENT_RECENT_MINUTES);
  const ordered = [...runs.active, ...runs.recent];

  const numberMatch = /^#?(\d+)$/.exec(target);
  if (numberMatch) {
    const index = Number.parseInt(numberMatch[1], 10);
    if (!Number.isFinite(index) || index < 1 || index > ordered.length) {
      return { run: null, error: `Unknown target ${target}.` };
    }
    return { run: ordered[index - 1] || null };
  }

  const normalized = target.toLowerCase();
  const exact = ordered.find((run) => run.runId.toLowerCase() === normalized);
  if (exact) return { run: exact };

  const byPrefix = ordered.find((run) => run.runId.toLowerCase().startsWith(normalized));
  if (byPrefix) return { run: byPrefix };

  const byAgent = ordered.find((run) => run.agentId.toLowerCase() === normalized);
  if (byAgent) return { run: byAgent };

  return { run: null, error: `Unknown target ${target}.` };
}

export function parseSubagentAction(
  payload: string,
  command?: string,
): { action: SubagentAction; args: string[] } {
  const normalizedCommand = (command || '').trim().toLowerCase();
  const tokens = payload
    .trim()
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (normalizedCommand === '/kill') {
    return { action: 'kill', args: tokens };
  }
  if (normalizedCommand === '/steer') {
    return { action: 'steer', args: tokens };
  }

  if (tokens.length === 0) {
    return { action: 'list', args: [] };
  }

  const first = tokens[0].toLowerCase();
  const args = tokens.slice(1);
  if (
    first === 'list' ||
    first === 'spawn' ||
    first === 'kill' ||
    first === 'steer' ||
    first === 'log' ||
    first === 'info' ||
    first === 'help' ||
    first === 'profiles'
  ) {
    return { action: first as SubagentAction, args };
  }

  // "/subagents <id>" falls back to info for convenience.
  return { action: 'info', args: tokens };
}
