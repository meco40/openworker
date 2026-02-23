import crypto from 'node:crypto';
import type { ChannelType, Skill } from '@/shared/domain/types';
import type { Conversation } from '@/server/channels/messages/repository';
import { approveCommand, isCommandApproved } from '@/server/gateway/exec-approval-manager';
import { evaluateNodeCommandPolicy } from '@/server/gateway/node-command-policy';
import { getSkillRepository } from '@/server/skills/skillRepository';
import { mapSkillsToTools } from '@/skills/definitions';
import {
  TOOL_APPROVAL_TTL_MS,
  TOOL_OUTPUT_MAX_CHARS,
  type PendingToolApproval,
  type ToolExecutionResult,
  type ResolvedToolContext,
} from './types';
import type { SubagentToolCallParams } from '@/server/skills/types';

export class ToolManager {
  private pendingToolApprovals = new Map<string, PendingToolApproval>();

  constructor(
    private readonly requiresInteractiveToolApproval: () => boolean,
    private readonly invokeSubagentToolCall?: (params: SubagentToolCallParams) => Promise<unknown>,
  ) {}

  prunePendingToolApprovals(now = Date.now()): void {
    for (const [token, pending] of this.pendingToolApprovals) {
      if (now - pending.createdAtMs > TOOL_APPROVAL_TTL_MS) {
        this.pendingToolApprovals.delete(token);
      }
    }
  }

  formatToolOutput(value: unknown): string {
    let output = '';

    if (typeof value === 'string') {
      output = value;
    } else {
      try {
        output = JSON.stringify(value, null, 2);
      } catch {
        output = String(value);
      }
    }

    const trimmed = output.trim();
    if (trimmed.length <= TOOL_OUTPUT_MAX_CHARS) {
      return trimmed;
    }

    const omitted = trimmed.length - TOOL_OUTPUT_MAX_CHARS;
    return `${trimmed.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n...(truncated ${omitted} chars)`;
  }

  buildToolApprovalPrompt(command: string): string {
    return [
      'Der angefragte CLI-Befehl braucht eine Freigabe.',
      '',
      `Command: ${command}`,
      '',
      'Waehle: Approve once, Approve always oder Deny.',
    ].join('\n');
  }

  buildApprovalMetadata(
    pending: PendingToolApproval,
    prompt: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ...extra,
      status: 'approval_required',
      approvalToken: pending.token,
      approval_token: pending.token,
      approvalPrompt: prompt,
      approval_prompt: prompt,
      approvalToolId: pending.toolId || null,
      approvalToolFunction: pending.toolFunctionName,
    };
  }

  createPendingApproval(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    toolFunctionName: string;
    toolId?: string;
    args?: Record<string, unknown>;
    command?: string;
  }): PendingToolApproval {
    this.prunePendingToolApprovals();
    const token = crypto.randomUUID();
    const pending: PendingToolApproval = {
      token,
      userId: params.conversation.userId,
      conversationId: params.conversation.id,
      platform: params.platform,
      externalChatId: params.externalChatId,
      toolFunctionName: params.toolFunctionName,
      toolId: params.toolId,
      args: params.args || {},
      command: params.command,
      createdAtMs: Date.now(),
    };
    this.pendingToolApprovals.set(token, pending);
    return pending;
  }

  async ensureShellSkillInstalled(): Promise<void> {
    const skillRepo = await getSkillRepository();
    const repoLike = skillRepo as Partial<{
      getSkill: (id: string) => { id: string; installed: boolean } | null;
      setInstalled: (id: string, installed: boolean) => boolean;
    }>;

    if (typeof repoLike.getSkill !== 'function' || typeof repoLike.setInstalled !== 'function') {
      return;
    }

    const requiredSkills = ['shell-access', 'subagents'];
    for (const skillId of requiredSkills) {
      const skill = repoLike.getSkill.call(skillRepo, skillId);
      if (skill && !skill.installed) {
        repoLike.setInstalled.call(skillRepo, skill.id, true);
      }
    }
  }

  async resolveToolContext(): Promise<ResolvedToolContext> {
    await this.ensureShellSkillInstalled();
    const skillRepo = await getSkillRepository();
    const skillRows = skillRepo.listSkills();
    const installedRows = skillRows.filter((row) => row.installed);

    const installedSkills: Skill[] = installedRows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      installed: row.installed,
      version: row.version,
      functionName: row.functionName,
      source: row.source,
      sourceUrl: row.sourceUrl ?? undefined,
    }));

    return {
      tools: mapSkillsToTools(installedSkills, 'openai'),
      installedFunctionNames: new Set(installedRows.map((row) => row.functionName)),
      functionToSkillId: new Map(installedRows.map((row) => [row.functionName, row.id])),
    };
  }

  private normalizeToolArgs(args: unknown): Record<string, unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return {};
    }
    return args as Record<string, unknown>;
  }

  async executeToolFunctionCall(params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    functionName: string;
    args: Record<string, unknown>;
    workspaceCwd?: string;
    installedFunctions: Set<string>;
    toolId?: string;
    skipApprovalCheck?: boolean;
  }): Promise<ToolExecutionResult> {
    const { functionName, args, installedFunctions } = params;

    if (!installedFunctions.has(functionName)) {
      return {
        kind: 'error',
        output: `Tool "${functionName}" ist nicht installiert.`,
      };
    }

    if (functionName === 'shell_execute') {
      const command = String(args.command || '').trim();
      if (!command) {
        return { kind: 'error', output: 'shell_execute requires command.' };
      }

      const policy = evaluateNodeCommandPolicy(command);
      if (!policy.allowed) {
        return {
          kind: 'error',
          output: policy.reason || 'Command blocked by security policy.',
        };
      }

      if (
        this.requiresInteractiveToolApproval() &&
        !params.skipApprovalCheck &&
        !isCommandApproved(policy.normalizedCommand)
      ) {
        const pending = this.createPendingApproval({
          conversation: params.conversation,
          platform: params.platform,
          externalChatId: params.externalChatId,
          toolFunctionName: functionName,
          toolId: params.toolId,
          args,
          command: policy.normalizedCommand,
        });
        return {
          kind: 'approval_required',
          prompt: this.buildToolApprovalPrompt(policy.normalizedCommand),
          pending,
        };
      }
    }

    try {
      const { dispatchSkill, normalizeSkillArgs } = await import('@/server/skills/executeSkill');
      const result = await dispatchSkill(functionName, normalizeSkillArgs(args), {
        bypassApproval: functionName === 'shell_execute' && Boolean(params.skipApprovalCheck),
        workspaceCwd: params.workspaceCwd,
        conversationId: params.conversation.id,
        userId: params.conversation.userId,
        platform: params.platform,
        externalChatId: params.externalChatId,
        invokeSubagentToolCall: this.invokeSubagentToolCall,
      });
      return {
        kind: 'ok',
        output: this.formatToolOutput(result),
      };
    } catch (error) {
      return {
        kind: 'error',
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getPendingApproval(token: string): PendingToolApproval | undefined {
    return this.pendingToolApprovals.get(token);
  }

  deletePendingApproval(token: string): boolean {
    return this.pendingToolApprovals.delete(token);
  }

  async approveCommand(command: string): Promise<void> {
    approveCommand(command);
  }
}
