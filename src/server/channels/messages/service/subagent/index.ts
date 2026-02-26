import type { ChannelType } from '@/shared/domain/types';
import type { Conversation } from '@/server/channels/messages/repository';
import type { SubagentRunRecord } from '@/server/agents/subagentRegistry';
import { abortSubagentRun, replaceSubagentRun } from '@/server/agents/subagentRegistry';
import {
  type SubagentAction,
  type SubagentDispatchContext,
  type ResolvedToolContext,
} from '../types';
import { listSubagentAgentProfiles } from '@/server/channels/messages/service/subagent/agentProfiles';
import type { SubagentManagerDeps } from './types';
import { filterToolContextForSubagent, resolveSubagentTarget, parseSubagentAction } from './utils';
import { startSubagentRun } from './lifecycle/start';
import { parseSpawnInput, formatSpawnSuccess, formatSpawnError } from './actions/spawn';
import { formatSubagentList, executeListAction } from './actions/list';
import {
  executeKillAllAction,
  executeKillTargetAction,
  formatKillMissingTargetError,
} from './actions/kill';

export class SubagentManager {
  constructor(
    private readonly getSubagentMaxActivePerConversation: () => number,
    private readonly resolveConversationWorkspace?: (conversation: Conversation) => {
      projectId?: string;
      workspacePath?: string;
      workspaceRelativePath?: string;
    } | null,
  ) {}

  parseSubagentAction(
    payload: string,
    command?: string,
  ): { action: SubagentAction; args: string[] } {
    return parseSubagentAction(payload, command);
  }

  formatSubagentList(conversationId: string): string {
    return formatSubagentList(conversationId);
  }

  resolveSubagentTarget(
    conversationId: string,
    rawTarget: string,
  ): { run: SubagentRunRecord | null; error?: string } {
    return resolveSubagentTarget(conversationId, rawTarget);
  }

  filterToolContextForSubagent(
    toolContext: ResolvedToolContext,
    allowedFunctionNames?: string[],
  ): ResolvedToolContext {
    return filterToolContextForSubagent(toolContext, allowedFunctionNames);
  }

  parseSpawnInput(args: string[]): {
    agentId: string;
    task: string;
    modelOverride?: string;
    error?: string;
  } {
    return parseSpawnInput(args);
  }

  formatSubagentProfiles(): string {
    const lines = ['Subagent profiles', ''];
    for (const profile of listSubagentAgentProfiles()) {
      const tools =
        profile.toolFunctionNames.length > 0 ? profile.toolFunctionNames.join(', ') : '(all)';
      const skills = profile.skillIds.length > 0 ? profile.skillIds.join(', ') : '(all)';
      const aliases = profile.aliases.length > 0 ? ` aliases: ${profile.aliases.join(', ')}` : '';
      lines.push(`- ${profile.id}: ${profile.description}`);
      lines.push(`  tools: ${tools}`);
      lines.push(`  skills: ${skills}${aliases}`);
    }
    return lines.join('\n');
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
    return startSubagentRun(params, {
      getSubagentMaxActivePerConversation: this.getSubagentMaxActivePerConversation,
      resolveConversationWorkspace: this.resolveConversationWorkspace,
    });
  }

  async executeSubagentAction(
    context: SubagentDispatchContext,
    action: SubagentAction,
    args: string[],
    deps: SubagentManagerDeps,
  ): Promise<{ text: string; payload?: Record<string, unknown> }> {
    const { conversation, platform, externalChatId } = context;

    if (action === 'help') {
      return {
        text: [
          'Subagent commands:',
          '- /subagents list',
          '- /subagents spawn <agentId> <task> [--model <model>]',
          '- /subagents profiles',
          '- /subagents kill <id|#|all>',
          '- /subagents steer <id|#> <message>',
          '- /subagents info <id|#>',
          '- /subagents log <id|#>',
          '- /kill <id|#|all>',
          '- /steer <id|#> <message>',
          '',
          this.formatSubagentProfiles(),
        ].join('\n'),
      };
    }

    if (action === 'profiles') {
      return {
        text: this.formatSubagentProfiles(),
        payload: {
          status: 'ok',
          action: 'profiles',
          profiles: listSubagentAgentProfiles(),
        },
      };
    }

    if (action === 'list') {
      return executeListAction(conversation.id);
    }

    if (action === 'spawn') {
      const parsed = this.parseSpawnInput(args);
      if (parsed.error) {
        return formatSpawnError(parsed.error);
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

      return formatSpawnSuccess(run);
    }

    if (action === 'kill') {
      const target = String(args[0] || '').trim();
      if (!target) {
        return formatKillMissingTargetError();
      }

      if (target === 'all' || target === '*') {
        return executeKillAllAction(conversation.id);
      }

      const resolved = this.resolveSubagentTarget(conversation.id, target);
      return executeKillTargetAction(target, resolved);
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
              run.profileId ? `profileId: ${run.profileId}` : null,
              run.profileName ? `profile: ${run.profileName}` : null,
              run.toolFunctionNames?.length ? `tools: ${run.toolFunctionNames.join(', ')}` : null,
              run.skillIds?.length ? `skills: ${run.skillIds.join(', ')}` : null,
              `status: ${run.status}`,
              `startedAt: ${run.startedAt}`,
              `endedAt: ${run.endedAt || '-'}`,
              `task: ${run.task}`,
              run.guidance ? `guidance: ${run.guidance}` : null,
              run.workspacePath ? `workspace: ${run.workspacePath}` : null,
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

// Re-export all registry functions for backward compatibility
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
} from './registry';

// Re-export types
export type {
  SubagentManagerDeps,
  ParsedSubagentAction,
  SpawnInputResult,
  SubagentTargetResult,
  ActionResult,
} from './types';
