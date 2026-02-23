import type { ChannelType } from '@/shared/domain/types';
import type { Conversation, StoredMessage } from '@/server/channels/messages/repository';
import { extractMemorySaveContent, type SubagentDispatchContext } from './types';
import { getMemoryService } from '@/server/memory/runtime';
import { resolveMemoryScopedUserId } from '@/server/memory/userScope';
import { getPersonaRepository } from '@/server/personas/personaRepository';
import { createPersonaProjectWorkspace } from '@/server/personas/personaProjectWorkspace';
import {
  getChannelBindingPersonaId,
  setChannelBindingPersona,
} from '@/server/channels/messages/channelBindingPersona';
import type { SubagentManager } from './subagentManager';
import type { ToolManager } from './toolManager';
import type { HistoryManager } from '@/server/channels/messages/historyManager';

export interface CommandHandlerDeps {
  subagentManager: SubagentManager;
  toolManager: ToolManager;
  historyManager: HistoryManager;
  resolveWorkspaceCwd?: (conversation: Conversation) => string | undefined;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<StoredMessage>;
  startSubagentRun: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    agentId: string;
    task: string;
    guidance?: string;
    modelOverride?: string;
  }) => Promise<import('@/server/agents/subagentRegistry').SubagentRunRecord>;
  runSubagent: (params: {
    conversation: Conversation;
    platform: ChannelType;
    externalChatId: string;
    run: import('@/server/agents/subagentRegistry').SubagentRunRecord;
  }) => Promise<void>;
}

export async function handleAutomationCommand(
  conversation: Conversation,
  payload: string,
  platform: ChannelType,
  externalChatId: string,
  sendResponse: CommandHandlerDeps['sendResponse'],
): Promise<StoredMessage> {
  const fullCommand = payload ? `/cron ${payload}` : '/cron';
  const { parseCronCommand } = await import('@/server/automation/commands');
  const parsed = parseCronCommand(fullCommand);

  const { getAutomationService } = await import('@/server/automation/runtime');
  const automationService = getAutomationService();

  switch (parsed.action) {
    case 'list': {
      const rules = automationService.listRules(conversation.userId);
      if (rules.length === 0) {
        return sendResponse(
          conversation,
          '⏱️ Keine Cron-Regeln vorhanden.\nNutze z. B.: `/cron add "0 10 * * *" --tz "Europe/Berlin" --prompt "Gib mir ein Briefing"`',
          platform,
          externalChatId,
        );
      }

      const lines = rules.map(
        (rule) =>
          `• ${rule.enabled ? '✓' : '⏸️'} **${rule.name}** (\`${rule.id}\`)\n  \`${rule.cronExpression}\` @ ${rule.timezone}\n  next: ${rule.nextRunAt || 'n/a'}`,
      );

      return sendResponse(
        conversation,
        `⏱️ **Cron-Regeln:**\n${lines.join('\n')}`,
        platform,
        externalChatId,
      );
    }

    case 'add':
    case 'every': {
      const rule = automationService.createRule({
        userId: conversation.userId,
        name: parsed.name || parsed.prompt.slice(0, 40),
        cronExpression: parsed.cronExpression,
        timezone: parsed.timezone,
        prompt: parsed.prompt,
        enabled: true,
      });

      return sendResponse(
        conversation,
        `✓ Cron-Regel erstellt: **${rule.name}**\nID: \`${rule.id}\`\nSchedule: \`${rule.cronExpression}\` (${rule.timezone})\nNächster Lauf: ${rule.nextRunAt || 'n/a'}`,
        platform,
        externalChatId,
      );
    }

    case 'pause': {
      const rule = automationService.updateRule(parsed.ruleId, conversation.userId, {
        enabled: false,
      });
      if (!rule) {
        return sendResponse(
          conversation,
          `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
          platform,
          externalChatId,
        );
      }
      return sendResponse(
        conversation,
        `⏸️ Regel **${rule.name}** pausiert.`,
        platform,
        externalChatId,
      );
    }

    case 'resume': {
      const rule = automationService.updateRule(parsed.ruleId, conversation.userId, {
        enabled: true,
      });
      if (!rule) {
        return sendResponse(
          conversation,
          `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
          platform,
          externalChatId,
        );
      }
      return sendResponse(
        conversation,
        `▶️ Regel **${rule.name}** aktiviert.`,
        platform,
        externalChatId,
      );
    }

    case 'remove': {
      const removed = automationService.deleteRule(parsed.ruleId, conversation.userId);
      if (!removed) {
        return sendResponse(
          conversation,
          `❌ Regel \`${parsed.ruleId}\` nicht gefunden.`,
          platform,
          externalChatId,
        );
      }
      return sendResponse(
        conversation,
        `🗑️ Regel \`${parsed.ruleId}\` gelöscht.`,
        platform,
        externalChatId,
      );
    }

    case 'run': {
      try {
        const run = automationService.createManualRun(parsed.ruleId, conversation.userId);
        return sendResponse(
          conversation,
          `🚀 Manueller Run erstellt: \`${run.id}\` (Regel: \`${run.ruleId}\`).`,
          platform,
          externalChatId,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Run konnte nicht erstellt werden.';
        return sendResponse(conversation, `❌ ${message}`, platform, externalChatId);
      }
    }

    case 'unsupported':
    default:
      return sendResponse(
        conversation,
        `⚠️ ${parsed.reason}\n\nUnterstützt:\n• /cron list\n• /cron add "<cron>" --tz "<TZ>" --prompt "<Text>"\n• /cron every "10m|1h|1d" --prompt "<Text>"\n• /cron pause <id>\n• /cron resume <id>\n• /cron remove <id>\n• /cron run <id>`,
        platform,
        externalChatId,
      );
  }
}

export async function handleShellCommand(
  conversation: Conversation,
  payload: string,
  platform: ChannelType,
  externalChatId: string,
  deps: CommandHandlerDeps,
): Promise<StoredMessage> {
  const command = String(payload || '').trim();
  if (!command) {
    return deps.sendResponse(
      conversation,
      'Bitte nutze /shell <command> oder !<command>.',
      platform,
      externalChatId,
    );
  }

  await deps.toolManager.ensureShellSkillInstalled();
  const toolContext = await deps.toolManager.resolveToolContext();
  const installedFunctions = new Set(toolContext.installedFunctionNames);
  installedFunctions.add('shell_execute');

  const toolExecution = await deps.toolManager.executeToolFunctionCall({
    conversation,
    platform,
    externalChatId,
    functionName: 'shell_execute',
    args: { command },
    workspaceCwd: deps.resolveWorkspaceCwd?.(conversation),
    installedFunctions,
    toolId: toolContext.functionToSkillId.get('shell_execute') || 'shell-access',
  });

  if (toolExecution.kind === 'approval_required') {
    return deps.sendResponse(
      conversation,
      toolExecution.prompt,
      platform,
      externalChatId,
      deps.toolManager.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
        ok: false,
        runtime: 'chat-shell-command',
      }),
    );
  }

  const message =
    toolExecution.kind === 'ok'
      ? `CLI command completed:\n${toolExecution.output}`
      : `CLI command failed:\n${toolExecution.output}`;

  return deps.sendResponse(conversation, message, platform, externalChatId, {
    ok: toolExecution.kind === 'ok',
    runtime: 'chat-shell-command',
    tool: 'shell_execute',
    command,
  });
}

export async function handleApprovalCommand(
  conversation: Conversation,
  payload: string,
  command: string | undefined,
  platform: ChannelType,
  externalChatId: string,
  deps: CommandHandlerDeps,
  respondToolApproval: (params: {
    conversationId: string;
    userId: string;
    approvalToken: string;
    approved: boolean;
    approveAlways?: boolean;
    toolId?: string;
    toolFunctionName?: string;
  }) => Promise<{
    ok: boolean;
    status: 'approved' | 'denied' | 'not_found' | 'approval_required';
    policyUpdated: boolean;
  }>,
): Promise<StoredMessage> {
  const token = String(payload || '').trim();
  const normalizedCommand = String(command || '').trim().toLowerCase();
  const approved = normalizedCommand === '/approve';

  if (!token) {
    return deps.sendResponse(
      conversation,
      'Usage: /approve <token> oder /deny <token>',
      platform,
      externalChatId,
    );
  }

  const before = deps.historyManager.listRecentMessages(conversation.id, conversation.userId, 20);
  const beforeIds = new Set(before.map((message) => message.id));

  const approvalResult = await respondToolApproval({
    conversationId: conversation.id,
    userId: conversation.userId,
    approvalToken: token,
    approved,
    approveAlways: false,
  });

  const after = deps.historyManager.listRecentMessages(conversation.id, conversation.userId, 20);
  const emittedAgentMessage =
    after.find((message) => message.role === 'agent' && !beforeIds.has(message.id)) || null;
  if (emittedAgentMessage) {
    return emittedAgentMessage;
  }

  if (approvalResult.status === 'not_found') {
    return deps.sendResponse(
      conversation,
      '⚠️ Approval-Token nicht gefunden oder abgelaufen.',
      platform,
      externalChatId,
    );
  }
  if (approvalResult.status === 'approval_required') {
    return deps.sendResponse(
      conversation,
      'Weitere Genehmigung erforderlich.',
      platform,
      externalChatId,
    );
  }
  if (approvalResult.status === 'denied') {
    return deps.sendResponse(conversation, 'Freigabe abgelehnt.', platform, externalChatId);
  }
  return deps.sendResponse(conversation, 'Freigabe verarbeitet.', platform, externalChatId);
}

export async function handleSubagentCommand(
  context: SubagentDispatchContext,
  payload: string,
  command: string | undefined,
  deps: CommandHandlerDeps,
): Promise<StoredMessage> {
  const parsed = deps.subagentManager.parseSubagentAction(payload, command);
  const result = await deps.subagentManager.executeSubagentAction(
    context,
    parsed.action,
    parsed.args,
    {
      startSubagentRun: deps.startSubagentRun,
      runSubagent: deps.runSubagent,
      sendResponse: deps.sendResponse,
    },
  );
  return deps.sendResponse(
    context.conversation,
    result.text,
    context.platform,
    context.externalChatId,
    {
      runtime: 'subagents-command',
      action: parsed.action,
      ...(result.payload || {}),
    },
  );
}

export async function handlePersonaCommand(
  conversation: Conversation,
  payload: string,
  platform: ChannelType,
  externalChatId: string,
  repo: {
    updatePersonaId: (id: string, personaId: string | null, userId: string) => void;
  },
  sendResponse: CommandHandlerDeps['sendResponse'],
): Promise<StoredMessage> {
  const lower = payload.toLowerCase().trim();

  // Load persona repository
  let personaRepo: ReturnType<typeof getPersonaRepository>;
  try {
    personaRepo = getPersonaRepository();
  } catch {
    return sendResponse(
      conversation,
      '⚠️ Persona-System nicht verfügbar.',
      platform,
      externalChatId,
    );
  }

  const personas = personaRepo.listPersonas(conversation.userId);

  // /persona (no args) → show current + help
  if (!lower) {
    const currentPersonaId = getChannelBindingPersonaId(repo, conversation.userId, platform);
    const currentPersona = currentPersonaId ? personaRepo.getPersona(currentPersonaId) : null;

    const lines = [
      '🎭 **Persona-System**',
      '',
      currentPersona
        ? `Aktive Persona: ${currentPersona.emoji} **${currentPersona.name}**`
        : 'Keine Persona aktiv (Default-Modus)',
      '',
      '**Befehle:**',
      '`/persona list` — Alle Personas anzeigen',
      '`/persona <Name>` — Persona wechseln',
      '`/persona off` — Persona deaktivieren',
    ];
    return sendResponse(conversation, lines.join('\n'), platform, externalChatId);
  }

  // /persona list → list all personas
  if (lower === 'list') {
    if (personas.length === 0) {
      return sendResponse(
        conversation,
        '🎭 Keine Personas erstellt.\nErstelle Personas in der WebApp unter "Agent Personas".',
        platform,
        externalChatId,
      );
    }

    const currentPersonaId = getChannelBindingPersonaId(repo, conversation.userId, platform);
    const lines = ['🎭 **Verfügbare Personas:**', ''];
    for (const p of personas) {
      const active = p.id === currentPersonaId ? ' ✓' : '';
      const vibe = p.vibe ? ` — _${p.vibe}_` : '';
      lines.push(`${p.emoji} **${p.name}**${vibe}${active}`);
    }
    lines.push('', 'Wechseln: `/persona <Name>`');
    return sendResponse(conversation, lines.join('\n'), platform, externalChatId);
  }

  // /persona off|clear|default → deactivate
  if (lower === 'off' || lower === 'clear' || lower === 'default') {
    setChannelBindingPersona(repo, conversation.userId, platform, null);
    // Also clear on current conversation
    repo.updatePersonaId(conversation.id, null, conversation.userId);
    return sendResponse(
      conversation,
      '🎭 Persona deaktiviert. Du chattest jetzt im Default-Modus.',
      platform,
      externalChatId,
    );
  }

  // /persona <name> → fuzzy match by name
  const match = personas.find(
    (p) => p.name.toLowerCase() === lower || p.name.toLowerCase().startsWith(lower),
  );

  if (!match) {
    const available = personas.map((p) => `${p.emoji} ${p.name}`).join(', ');
    return sendResponse(
      conversation,
      `⚠️ Persona "${payload}" nicht gefunden.\nVerfügbar: ${available || '(keine)'}`,
      platform,
      externalChatId,
    );
  }

  // Apply persona to channel binding + current conversation
  setChannelBindingPersona(repo, conversation.userId, platform, match.id);
  repo.updatePersonaId(conversation.id, match.id, conversation.userId);

  return sendResponse(
    conversation,
    `🎭 Persona gewechselt: ${match.emoji} **${match.name}**\nAlle neuen Nachrichten in ${platform} nutzen jetzt diese Persona.`,
    platform,
    externalChatId,
  );
}

export async function handleProjectCommand(
  conversation: Conversation,
  payload: string,
  platform: ChannelType,
  externalChatId: string,
  repo: {
    createProject?: (input: {
      userId: string;
      personaId: string;
      name: string;
      workspacePath: string;
      workspaceRelativePath?: string;
    }) => { id: string; name: string; slug: string; workspacePath: string };
    listProjectsByPersona?: (
      personaId: string,
      userId: string,
    ) => Array<{ id: string; name: string; slug: string; workspacePath: string }>;
    getProjectByIdOrSlug?: (
      personaId: string,
      userId: string,
      idOrSlug: string,
    ) => { id: string; name: string; slug: string; workspacePath: string } | null;
    setActiveProjectForConversation?: (
      conversationId: string,
      userId: string,
      projectId: string | null,
    ) => void;
    getConversationProjectState?: (
      conversationId: string,
      userId: string,
    ) => { activeProjectId: string | null };
  },
  sendResponse: CommandHandlerDeps['sendResponse'],
): Promise<StoredMessage> {
  if (!conversation.personaId) {
    return sendResponse(
      conversation,
      '⚠️ Kein Persona-Kontext aktiv. Bitte zuerst `/persona <name>` setzen.',
      platform,
      externalChatId,
    );
  }

  if (
    typeof repo.createProject !== 'function' ||
    typeof repo.listProjectsByPersona !== 'function' ||
    typeof repo.getProjectByIdOrSlug !== 'function' ||
    typeof repo.setActiveProjectForConversation !== 'function' ||
    typeof repo.getConversationProjectState !== 'function'
  ) {
    return sendResponse(
      conversation,
      '⚠️ Projektverwaltung ist in diesem Runtime-Modus nicht verfügbar.',
      platform,
      externalChatId,
    );
  }

  const trimmed = String(payload || '').trim();
  const [rawAction, ...restTokens] = trimmed.split(/\s+/).filter(Boolean);
  const action = String(rawAction || 'status').toLowerCase();
  const rest = restTokens.join(' ').trim();

  if (action === 'new') {
    const name = rest;
    if (!name) {
      return sendResponse(
        conversation,
        'Usage: /project new <name>',
        platform,
        externalChatId,
      );
    }
    const persona = getPersonaRepository().getPersona(conversation.personaId);
    if (!persona?.slug) {
      return sendResponse(
        conversation,
        '⚠️ Aktive Persona nicht gefunden.',
        platform,
        externalChatId,
      );
    }

    const workspace = createPersonaProjectWorkspace({
      personaSlug: persona.slug,
      task: name,
      requestedName: name,
    });
    const project = repo.createProject({
      userId: conversation.userId,
      personaId: conversation.personaId,
      name,
      workspacePath: workspace.absolutePath,
      workspaceRelativePath: workspace.relativePath,
    });
    repo.setActiveProjectForConversation(conversation.id, conversation.userId, project.id);

    return sendResponse(
      conversation,
      `✅ Projekt erstellt und aktiv: ${project.name}\nID: ${project.id}\nSlug: ${project.slug}`,
      platform,
      externalChatId,
    );
  }

  if (action === 'list') {
    const projects = repo.listProjectsByPersona(conversation.personaId, conversation.userId);
    if (projects.length === 0) {
      return sendResponse(
        conversation,
        'Keine Projekte vorhanden. Erzeuge eines mit `/project new <name>`.',
        platform,
        externalChatId,
      );
    }
    const lines = ['📁 Projekte:', ''];
    projects.forEach((project, index) => {
      lines.push(`${index + 1}. ${project.name} (${project.slug})`);
    });
    return sendResponse(conversation, lines.join('\n'), platform, externalChatId);
  }

  if (action === 'use') {
    const identifier = rest;
    if (!identifier) {
      return sendResponse(
        conversation,
        'Usage: /project use <id|slug>',
        platform,
        externalChatId,
      );
    }
    const project = repo.getProjectByIdOrSlug(conversation.personaId, conversation.userId, identifier);
    if (!project) {
      return sendResponse(
        conversation,
        `⚠️ Projekt nicht gefunden: ${identifier}`,
        platform,
        externalChatId,
      );
    }
    repo.setActiveProjectForConversation(conversation.id, conversation.userId, project.id);
    return sendResponse(
      conversation,
      `✅ Aktives Projekt: ${project.name} (${project.slug})`,
      platform,
      externalChatId,
    );
  }

  if (action === 'clear') {
    repo.setActiveProjectForConversation(conversation.id, conversation.userId, null);
    return sendResponse(conversation, 'Aktives Projekt wurde entfernt.', platform, externalChatId);
  }

  const state = repo.getConversationProjectState(conversation.id, conversation.userId);
  if (!state.activeProjectId) {
    return sendResponse(
      conversation,
      'Kein aktives Projekt gesetzt. Nutze `/project new <name>` oder `/project use <id|slug>`.',
      platform,
      externalChatId,
    );
  }

  const project = repo.getProjectByIdOrSlug(
    conversation.personaId,
    conversation.userId,
    state.activeProjectId,
  );
  if (!project) {
    return sendResponse(
      conversation,
      'Aktives Projekt nicht mehr verfügbar.',
      platform,
      externalChatId,
    );
  }
  return sendResponse(
    conversation,
    `Aktives Projekt: ${project.name}\nID: ${project.id}\nSlug: ${project.slug}`,
    platform,
    externalChatId,
  );
}

export async function handleMemorySave(
  conversation: Conversation,
  content: string,
  platform: ChannelType,
  externalChatId: string,
  sendResponse: CommandHandlerDeps['sendResponse'],
): Promise<{ saved: boolean; message?: StoredMessage }> {
  const memoryContent = extractMemorySaveContent(content);

  if (memoryContent === null) {
    return { saved: false };
  }

  if (!memoryContent) {
    return {
      saved: false,
      message: await sendResponse(
        conversation,
        '⚠️ Bitte schreibe nach `Speichere ab:` auch den Inhalt.',
        platform,
        externalChatId,
      ),
    };
  }

  if (!conversation.personaId) {
    return {
      saved: false,
      message: await sendResponse(
        conversation,
        '⚠️ Keine Persona aktiv. Bitte zuerst eine Persona wählen, dann `Speichere ab: ...` nutzen.',
        platform,
        externalChatId,
      ),
    };
  }

  try {
    const memoryUserId = resolveMemoryScopedUserId({
      userId: conversation.userId,
      channelType: platform || conversation.channelType,
      externalChatId: externalChatId || conversation.externalChatId || 'default',
    });
    await getMemoryService().store(conversation.personaId, 'fact', memoryContent, 4, memoryUserId, {
      subject: 'user',
      sourceRole: 'user',
      sourceType: 'manual_save',
    });
    return {
      saved: true,
      message: await sendResponse(
        conversation,
        `✅ Gespeichert: ${memoryContent}`,
        platform,
        externalChatId,
      ),
    };
  } catch (error) {
    console.error('Memory store failed:', error);
    return {
      saved: false,
      message: await sendResponse(
        conversation,
        '⚠️ Memory konnte nicht gespeichert werden.',
        platform,
        externalChatId,
      ),
    };
  }
}
