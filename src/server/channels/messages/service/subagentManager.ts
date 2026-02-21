import type { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/server/channels/messages/repository';
import {
  abortSubagentRun,
  attachSubagentRuntime,
  completeSubagentRun,
  countActiveSubagentRuns,
  createSubagentRun,
  detachSubagentRuntime,
  failSubagentRun,
  listActiveSubagentRuns,
  listSubagentRunsForConversation,
  markSubagentRunKilled,
  replaceSubagentRun,
  type SubagentRunRecord,
} from '@/server/agents/subagentRegistry';
import {
  SUBAGENT_RECENT_MINUTES,
  SUBAGENT_DEFAULT_AGENT_ID,
  type SubagentAction,
  type SubagentDispatchContext,
  type ResolvedToolContext,
} from './types';

export class SubagentManager {
  constructor(private readonly getSubagentMaxActivePerConversation: () => number) {}

  parseSubagentAction(
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
      first === 'help'
    ) {
      return { action: first as SubagentAction, args };
    }

    // "/subagents <id>" falls back to info for convenience.
    return { action: 'info', args: tokens };
  }

  formatSubagentList(conversationId: string): string {
    const runs = listSubagentRunsForConversation(conversationId, SUBAGENT_RECENT_MINUTES);
    const lines: string[] = [];
    lines.push('Subagents');
    lines.push('');
    lines.push('active:');
    if (runs.active.length === 0) {
      lines.push('(none)');
    } else {
      runs.active.forEach((run, index) => {
        lines.push(`${index + 1}. ${run.agentId} (${run.runId.slice(0, 8)}) - running`);
      });
    }
    lines.push('');
    lines.push(`recent (last ${SUBAGENT_RECENT_MINUTES}m):`);
    if (runs.recent.length === 0) {
      lines.push('(none)');
    } else {
      runs.recent.forEach((run, index) => {
        const status = run.status;
        const preview = (run.resultPreview || run.error || '').trim();
        const suffix = preview ? ` - ${preview.slice(0, 80)}` : '';
        lines.push(`${index + 1}. ${run.agentId} (${run.runId.slice(0, 8)}) - ${status}${suffix}`);
      });
    }
    return lines.join('\n');
  }

  resolveSubagentTarget(
    conversationId: string,
    rawTarget: string,
  ): { run: SubagentRunRecord | null; error?: string } {
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

  filterToolContextForSubagent(toolContext: ResolvedToolContext): ResolvedToolContext {
    const filteredTools = toolContext.tools.filter((tool) => {
      if (!tool || typeof tool !== 'object') return true;
      const entry = tool as { function?: { name?: unknown }; name?: unknown };
      const functionName =
        typeof entry.function?.name === 'string'
          ? entry.function.name
          : typeof entry.name === 'string'
            ? entry.name
            : '';
      return functionName !== 'subagents';
    });

    const installedFunctionNames = new Set(toolContext.installedFunctionNames);
    installedFunctionNames.delete('subagents');

    const functionToSkillId = new Map(toolContext.functionToSkillId);
    functionToSkillId.delete('subagents');

    return {
      tools: filteredTools,
      installedFunctionNames,
      functionToSkillId,
    };
  }

  parseSpawnInput(args: string[]): {
    agentId: string;
    task: string;
    modelOverride?: string;
    error?: string;
  } {
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

  async startSubagentRun(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    agentId: string;
    task: string;
    guidance?: string;
    modelOverride?: string;
  }): Promise<SubagentRunRecord> {
    const active = countActiveSubagentRuns(params.conversation.id);
    const maxActive = this.getSubagentMaxActivePerConversation();
    if (active >= maxActive) {
      throw new Error(`Subagent limit reached (${active}/${maxActive}).`);
    }

    const run = createSubagentRun({
      requesterConversationId: params.conversation.id,
      requesterUserId: params.conversation.userId,
      agentId: params.agentId,
      task: params.task,
      guidance: params.guidance,
      modelOverride: params.modelOverride,
    });

    return run;
  }

  async executeSubagentAction(
    context: SubagentDispatchContext,
    action: SubagentAction,
    args: string[],
    deps: {
      startSubagentRun: (params: {
        conversation: Conversation;
        platform: ChannelType;
        externalChatId: string;
        agentId: string;
        task: string;
        guidance?: string;
        modelOverride?: string;
      }) => Promise<SubagentRunRecord>;
      runSubagent: (params: {
        conversation: Conversation;
        platform: ChannelType;
        externalChatId: string;
        run: SubagentRunRecord;
      }) => Promise<void>;
      sendResponse: (
        conversation: Conversation,
        content: string,
        platform: ChannelType,
        externalChatId: string,
        metadata?: Record<string, unknown>,
      ) => Promise<unknown>;
    },
  ): Promise<{ text: string; payload?: Record<string, unknown> }> {
    const { conversation, platform, externalChatId } = context;

    if (action === 'help') {
      return {
        text: [
          'Subagent commands:',
          '- /subagents list',
          '- /subagents spawn <agentId> <task> [--model <model>]',
          '- /subagents kill <id|#|all>',
          '- /subagents steer <id|#> <message>',
          '- /subagents info <id|#>',
          '- /subagents log <id|#>',
          '- /kill <id|#|all>',
          '- /steer <id|#> <message>',
        ].join('\n'),
      };
    }

    if (action === 'list') {
      const runs = listSubagentRunsForConversation(conversation.id, SUBAGENT_RECENT_MINUTES);
      return {
        text: this.formatSubagentList(conversation.id),
        payload: {
          status: 'ok',
          action: 'list',
          active: runs.active,
          recent: runs.recent,
        },
      };
    }

    if (action === 'spawn') {
      const parsed = this.parseSpawnInput(args);
      if (parsed.error) {
        return {
          text: parsed.error,
          payload: {
            status: 'error',
            action: 'spawn',
            error: parsed.error,
          },
        };
      }
      const run = await deps.startSubagentRun({
        conversation,
        platform,
        externalChatId,
        agentId: parsed.agentId,
        task: parsed.task,
        modelOverride: parsed.modelOverride,
      });
      
      // Start the subagent run asynchronously
      void deps.runSubagent({
        conversation,
        platform,
        externalChatId,
        run,
      });

      return {
        text: `Spawned subagent ${run.agentId} (${run.runId.slice(0, 8)}).`,
        payload: {
          status: 'accepted',
          action: 'spawn',
          runId: run.runId,
          agentId: run.agentId,
        },
      };
    }

    if (action === 'kill') {
      const target = String(args[0] || '').trim();
      if (!target) {
        return {
          text: 'Usage: /subagents kill <id|#|all>',
          payload: {
            status: 'error',
            action: 'kill',
            error: 'Missing target.',
          },
        };
      }

      if (target === 'all' || target === '*') {
        const activeRuns = listActiveSubagentRuns(conversation.id);
        let killed = 0;
        for (const run of activeRuns) {
          const wasRunning = abortSubagentRun(run.runId, 'Subagent run was stopped by requester.');
          if (wasRunning || run.status === 'running') {
            killed += 1;
          }
        }
        return {
          text:
            killed > 0
              ? `Killed ${killed} subagent${killed === 1 ? '' : 's'}.`
              : 'No running subagents.',
          payload: {
            status: 'ok',
            action: 'kill',
            target: 'all',
            killed,
          },
        };
      }

      const resolved = this.resolveSubagentTarget(conversation.id, target);
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
      const wasRunning = abortSubagentRun(
        resolved.run.runId,
        'Subagent run was stopped by requester.',
      );
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

    if (action === 'steer') {
      const target = String(args[0] || '').trim();
      const guidance = args.slice(1).join(' ').trim();
      if (!target || !guidance) {
        return {
          text: 'Usage: /subagents steer <id|#> <message>',
          payload: {
            status: 'error',
            action: 'steer',
            error: 'Missing target or message.',
          },
        };
      }

      const resolved = this.resolveSubagentTarget(conversation.id, target);
      if (!resolved.run) {
        return {
          text: resolved.error || 'Unknown subagent target.',
          payload: {
            status: 'error',
            action: 'steer',
            target,
            error: resolved.error || 'Unknown subagent target.',
          },
        };
      }

      const previous = resolved.run;
      if (previous.status === 'running') {
        abortSubagentRun(previous.runId, 'Run interrupted by steer request.');
      }

      const replacement = await deps.startSubagentRun({
        conversation,
        platform,
        externalChatId,
        agentId: previous.agentId,
        task: previous.task,
        guidance,
        modelOverride: previous.modelOverride,
      });

      // Start the replacement run
      void deps.runSubagent({
        conversation,
        platform,
        externalChatId,
        run: replacement,
      });

      replaceSubagentRun(previous.runId, replacement.runId);

      return {
        text: `Steered ${previous.agentId}: ${replacement.runId.slice(0, 8)} started.`,
        payload: {
          status: 'accepted',
          action: 'steer',
          target,
          previousRunId: previous.runId,
          runId: replacement.runId,
        },
      };
    }

    if (action === 'info' || action === 'log') {
      const target = String(args[0] || '').trim();
      if (!target) {
        return {
          text: `Usage: /subagents ${action} <id|#>`,
          payload: {
            status: 'error',
            action,
            error: 'Missing target.',
          },
        };
      }
      const resolved = this.resolveSubagentTarget(conversation.id, target);
      if (!resolved.run) {
        return {
          text: resolved.error || 'Unknown subagent target.',
          payload: {
            status: 'error',
            action,
            target,
            error: resolved.error || 'Unknown subagent target.',
          },
        };
      }

      const run = resolved.run;
      const logText =
        action === 'log'
          ? run.resultPreview || run.error || '(no output)'
          : [
              `runId: ${run.runId}`,
              `agentId: ${run.agentId}`,
              `status: ${run.status}`,
              `startedAt: ${run.startedAt}`,
              `endedAt: ${run.endedAt || '-'}`,
              `task: ${run.task}`,
              run.guidance ? `guidance: ${run.guidance}` : null,
              run.error ? `error: ${run.error}` : null,
            ]
              .filter(Boolean)
              .join('\n');
      return {
        text: logText,
        payload: {
          status: 'ok',
          action,
          run,
        },
      };
    }

    return {
      text: 'Unsupported subagent action.',
      payload: {
        status: 'error',
        action,
        error: 'Unsupported subagent action.',
      },
    };
  }
}

export {
  abortSubagentRun,
  attachSubagentRuntime,
  completeSubagentRun,
  countActiveSubagentRuns,
  createSubagentRun,
  detachSubagentRuntime,
  failSubagentRun,
  listActiveSubagentRuns,
  listSubagentRunsForConversation,
  markSubagentRunKilled,
  replaceSubagentRun,
  type SubagentRunRecord,
};
