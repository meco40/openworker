/**
 * Build execution and autonomous mode utilities
 * Extracted from the monolithic index.ts
 */

import type { Conversation } from '@/server/channels/messages/repository';
import type { ChannelType } from '@/shared/domain/types';
import type { ToolManager } from '@/server/channels/messages/service/toolManager';
import { resolveAutonomousBuildMaxToolCalls } from '../core/configuration';
import type { ToolExecutionResult } from '../core/types';

/**
 * Build autonomous execution directive
 */
export function buildAutonomousExecutionDirective(params: {
  workspaceCwd?: string;
  buildIntent: boolean;
  isAutonomousPersona?: boolean;
}): string | null {
  if (!params.buildIntent && !params.isAutonomousPersona) return null;

  const sharedAntiLoopDirectives = [
    '- Tool-Calls silent ausfuehren — NICHT beschreiben was du tun wirst, einfach tun.',
    '- Polling-Loops strikt verboten: ausreichend Timeout nutzen statt rapid-retry. Min. 5s Pause zwischen Wiederholungen.',
    '- Bei 2+ identischen Tool-Calls mit gleichem Ergebnis: Strategie sofort wechseln, nicht weiter wiederholen.',
    '- Bei Fehlern: Fehlerausgabe vollstaendig lesen und Root Cause verstehen BEVOR du retry machst.',
  ];

  const lines = params.isAutonomousPersona
    ? [
        'AUTONOMOUS AGENT MODE:',
        '- Du bist ein autonomer Agent. Handele eigenstaendig end-to-end ohne Rueckfragen.',
        '- Nutze alle verfuegbaren Tools aktiv: Shell, Filesystem, Browser, Python, HTTP, Web-Search, PDF.',
        '- Erkenne und korrigiere Fehler proaktiv. Versuche alternative Strategien wenn ein Ansatz scheitert.',
        '- Gib Zwischenstatus nach jedem wesentlichen Schritt in einem Satz aus.',
        '- Antworte ohne ueberfluessige Codeblöcke; liefere Fakten, Ergebnisse, geaenderte Dateien.',
        params.workspaceCwd ? `- Aktives Workspace-Verzeichnis: ${params.workspaceCwd}` : null,
        ...sharedAntiLoopDirectives,
      ]
    : [
        'AUTONOMOUS EXECUTION MODE (build task):',
        '- Arbeite end-to-end im aktiven Projekt-Workspace statt nur Plantext zu geben.',
        '- Nutze Tools aktiv fuer Inspektion, Umsetzung und Verifikation.',
        '- Wenn die Aufgabe coding/build ist, fuehre reale Datei- und CLI-Schritte aus.',
        '- Buendle Shell-Schritte in moeglichst wenige, robuste Befehle statt viele Mini-Calls.',
        '- Antworte ohne Codebloeke; gib stattdessen Status, geaenderte Dateien, Verifikation und Startkommando.',
        '- Nur bei Fehlern kurze, relevante Fehlersnippets zeigen.',
        params.workspaceCwd ? `- Aktives Workspace-Verzeichnis: ${params.workspaceCwd}` : null,
        ...sharedAntiLoopDirectives,
      ];

  return lines.filter(Boolean).join('\n');
}

/**
 * Resolve maximum tool calls
 */
export function resolveMaxToolCalls(params: {
  isAutonomousPersona: boolean;
  activePersona: { maxToolCalls?: number } | null;
  buildIntent: boolean;
  overrideMaxToolCalls?: number;
}): number | undefined {
  if (params.overrideMaxToolCalls !== undefined) {
    return params.overrideMaxToolCalls;
  }

  if (params.isAutonomousPersona && params.activePersona) {
    return params.activePersona.maxToolCalls;
  }

  if (params.buildIntent) {
    return resolveAutonomousBuildMaxToolCalls();
  }

  return undefined;
}

/**
 * Run build workspace preflight check
 */
export async function runBuildWorkspacePreflight(params: {
  conversation: Conversation;
  platform: ChannelType;
  externalChatId: string;
  workspaceCwd: string;
  toolManager: ToolManager;
  sendResponse: (
    conversation: Conversation,
    content: string,
    platform: ChannelType,
    externalChatId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<import('@/server/channels/messages/repository').StoredMessage>;
}): Promise<ToolExecutionResult> {
  const { conversation, platform, externalChatId, workspaceCwd, toolManager, sendResponse } =
    params;

  const toolContext = await toolManager.resolveToolContext();

  const command =
    process.platform === 'win32'
      ? 'Get-Location; Get-ChildItem -Force | Select-Object -First 30 Name,Mode,Length'
      : 'pwd; ls -la | head -n 40';

  const toolExecution = await toolManager.executeToolFunctionCall({
    conversation,
    platform,
    externalChatId,
    functionName: 'shell_execute',
    args: { command },
    workspaceCwd,
    installedFunctions: toolContext.installedFunctionNames,
    toolId: toolContext.functionToSkillId.get('shell_execute') || 'shell-access',
  });

  if (toolExecution.kind === 'approval_required') {
    return {
      kind: 'approval_required',
      message: await sendResponse(
        conversation,
        toolExecution.prompt,
        platform,
        externalChatId,
        toolManager.buildApprovalMetadata(toolExecution.pending, toolExecution.prompt, {
          ok: false,
          runtime: 'build-workspace-preflight',
        }),
      ),
    };
  }

  const summaryPrefix =
    toolExecution.kind === 'ok' ? '[Workspace preflight result]' : '[Workspace preflight failed]';

  return {
    kind: 'summary',
    text: `${summaryPrefix}\n${toolExecution.output}`,
  };
}
