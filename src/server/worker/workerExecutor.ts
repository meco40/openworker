// ─── Worker Executor ─────────────────────────────────────────
// Executes a single step with real tool-calling loop via AI.
// Tools are dispatched to actual skill handlers.

import { getModelHubService, getModelHubEncryptionKey } from '../model-hub/runtime';
import { getWorkerRepository } from './workerRepository';
import { getWorkspaceManager } from './workspaceManager';
import { getClawHubService } from '../clawhub/clawhubService';
import { shellExecuteHandler } from '../skills/handlers/shellExecute';
import { fileReadHandler } from '../skills/handlers/fileRead';
import { browserSnapshotHandler } from '../skills/handlers/browserSnapshot';
import { pythonExecuteHandler } from '../skills/handlers/pythonExecute';
import type { WorkerTaskRecord, WorkerStepRecord, WorkerArtifactRecord } from './workerTypes';
import type { OrchestraGraphNode } from './orchestraGraph';

// ─── Tool Definitions ───────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'shell_execute',
      description:
        'Executes a shell command (PowerShell on Windows, bash on Unix). Returns stdout, stderr, exitCode.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'file_read',
      description: 'Reads the content of a file. Path is relative to workspace or absolute.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Writes content to a file in the workspace. Creates directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path within workspace' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_fetch',
      description: 'Fetches a URL and extracts title, description, and text excerpt.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'python_execute',
      description: 'Executes Python code and returns stdout/stderr.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python code to execute' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_web',
      description: 'Searches the web and returns results. Use browser_fetch for specific URLs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
];

// ─── Tool Dispatcher ────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function createToolDispatcher(taskId: string): Record<string, ToolHandler> {
  const wsMgr = getWorkspaceManager();

  return {
    shell_execute: async (args) => shellExecuteHandler(args),
    file_read: async (args) => fileReadHandler(args),
    write_file: async (args) => {
      const filePath = String(args.path || '').trim();
      const content = String(args.content || '');
      if (!filePath) throw new Error('write_file requires path');
      wsMgr.writeFile(taskId, filePath, content);
      return { ok: true, path: filePath, bytesWritten: content.length };
    },
    browser_fetch: async (args) => browserSnapshotHandler(args),
    python_execute: async (args) => pythonExecuteHandler(args),
    search_web: async (args) => {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('search_web requires query');
      const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      return browserSnapshotHandler({ url: searchUrl });
    },
  };
}

// ─── System Prompt ──────────────────────────────────────────

const EXECUTOR_SYSTEM = `Du bist ein autonomer Worker-Agent mit Zugriff auf echte Tools.
Du führst einen einzelnen Schritt einer größeren Aufgabe aus.

REGELN:
- Nutze Tools wenn nötig, um den Schritt auszuführen
- Schreibe Ergebnisdateien mit write_file in den Workspace
- Antworte IMMER mit einer kurzen Zusammenfassung des Ergebnisses
- Bei Fehlern: versuche es mit alternativen Ansätzen bevor du aufgibst
- Maximal 10 Tool-Aufrufe pro Schritt

KONTEXT:
- Task: {title}
- Zielsetzung: {objective}
- Workspace-Typ: {workspaceType}
- Aktueller Schritt: {step}`;

// ─── Types ──────────────────────────────────────────────────

export interface StepResult {
  output: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  artifacts?: Array<{
    name: string;
    type: WorkerArtifactRecord['type'];
    content: string;
    mimeType?: string;
  }>;
}

// ─── Main Executor ──────────────────────────────────────────

const MAX_TOOL_LOOPS = 10;

/**
 * Executes a single step with a full tool-calling loop.
 * The AI can request function calls, the executor dispatches them to
 * real skill handlers, feeds results back, and loops until the AI
 * provides a final text response without function calls.
 */
export async function executeStep(
  task: WorkerTaskRecord,
  step: WorkerStepRecord,
  toolsOverride?: typeof TOOL_DEFINITIONS,
): Promise<StepResult> {
  const tools = toolsOverride ?? TOOL_DEFINITIONS;
  const service = getModelHubService();
  const encryptionKey = getModelHubEncryptionKey();
  const dispatcher = createToolDispatcher(task.id);
  let clawHubPromptBlock = '';
  try {
    clawHubPromptBlock = await getClawHubService().getPromptBlock();
  } catch {
    clawHubPromptBlock = '';
  }

  const baseSystemPrompt = EXECUTOR_SYSTEM.replace('{title}', task.title)
    .replace('{objective}', task.objective)
    .replace('{workspaceType}', task.workspaceType || 'general')
    .replace('{step}', step.description);
  const systemPrompt = clawHubPromptBlock.trim()
    ? `${baseSystemPrompt}\n\n---\n\n${clawHubPromptBlock.trim()}`
    : baseSystemPrompt;

  // Messages use GatewayMessage-compatible shape (role: system|user|assistant)
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Führe diesen Schritt aus: ${step.description}` },
  ];

  const toolCallLog: Array<{ name: string; args: Record<string, unknown>; result: string }> = [];
  const collectedArtifacts: StepResult['artifacts'] = [];

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const result = await service.dispatchWithFallback('p1', encryptionKey, {
      messages,
      tools,
      auditContext: {
        kind: 'worker_executor',
        taskId: task.id,
        stepId: step.id,
      },
    });

    if (!result.ok) {
      throw new Error(`AI dispatch failed: ${result.error || 'Unknown error'}`);
    }

    // Check for function calls from the gateway response (provider-agnostic)
    const fnCalls = result.functionCalls;

    if (!fnCalls || fnCalls.length === 0) {
      // No function calls → AI is done, return final text
      return {
        output: result.text || 'Schritt ausgeführt',
        toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
        artifacts: collectedArtifacts.length > 0 ? collectedArtifacts : undefined,
      };
    }

    // Process each function call
    const toolResults: string[] = [];

    for (const fc of fnCalls) {
      const fnName = fc.name;
      const args = (fc.args || {}) as Record<string, unknown>;

      let resultStr: string;
      try {
        const handler = dispatcher[fnName];
        if (!handler) {
          resultStr = JSON.stringify({ error: `Unknown tool: ${fnName}` });
        } else {
          // Shell commands need approval
          if (fnName === 'shell_execute') {
            const command = String(args.command || '');
            const approval = await requestCommandApproval(task.id, command);
            if (approval === 'denied') {
              resultStr = JSON.stringify({ error: 'Command denied by user', command });
              toolCallLog.push({ name: fnName, args, result: resultStr });
              toolResults.push(`[${fnName}] DENIED: ${command}`);
              continue;
            }
          }

          const toolResult = await handler(args);
          resultStr = JSON.stringify(toolResult);

          // Track write_file calls as artifacts
          if (fnName === 'write_file' && args.path) {
            collectedArtifacts.push({
              name: String(args.path),
              type: 'file',
              content: String(args.content || ''),
            });
          }
        }
      } catch (err) {
        resultStr = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }

      toolCallLog.push({ name: fnName, args, result: resultStr });
      toolResults.push(`[${fnName}](${JSON.stringify(args)}) → ${resultStr.slice(0, 500)}`);
    }

    // Feed tool results back as messages for the next AI turn
    messages.push({
      role: 'assistant',
      content: result.text || `Calling tools: ${fnCalls.map((f) => f.name).join(', ')}`,
    });
    messages.push({
      role: 'user',
      content: `Tool-Ergebnisse:\n${toolResults.join('\n')}\n\nSetze den Schritt fort oder gib deine Zusammenfassung.`,
    });
  }

  // Max loops reached
  return {
    output:
      `Schritt nach ${MAX_TOOL_LOOPS} Tool-Schleifen abgeschlossen. ` +
      `${toolCallLog.length} Tool-Aufrufe ausgeführt.`,
    toolCalls: toolCallLog,
    artifacts: collectedArtifacts.length > 0 ? collectedArtifacts : undefined,
  };
}

export async function executeOrchestraNode(
  task: WorkerTaskRecord,
  node: { id: string; description?: string; skillIds?: string[] },
): Promise<StepResult> {
  const syntheticStep: WorkerStepRecord = {
    id: `orch-${task.id}-${node.id}`,
    taskId: task.id,
    stepIndex: 0,
    description: node.description || `Orchestra node ${node.id}`,
    status: 'pending',
    output: null,
    toolCalls: null,
    startedAt: null,
    completedAt: null,
  };

  // If skillIds are specified, filter TOOL_DEFINITIONS to only matching function names
  if (node.skillIds && node.skillIds.length > 0) {
    const allowedSet = new Set(node.skillIds);
    const filteredTools = TOOL_DEFINITIONS.filter((tool) => allowedSet.has(tool.function.name));
    // Use filtered tools for this node (pass via step metadata)
    return executeStepWithTools(
      task,
      syntheticStep,
      filteredTools.length > 0 ? filteredTools : TOOL_DEFINITIONS,
    );
  }

  return executeStep(task, syntheticStep);
}

/** executeStep with explicit tool definitions override. */
function executeStepWithTools(
  task: WorkerTaskRecord,
  step: WorkerStepRecord,
  tools: typeof TOOL_DEFINITIONS,
): Promise<StepResult> {
  return executeStep(task, step, tools);
}

// ─── LLM Routing Decision ───────────────────────────────────

const LLM_ROUTING_SYSTEM = `Du bist ein Routing-Agent in einem Workflow-Orchestrator.
Nach Abschluss eines Knotens musst du entscheiden, an welche(n) nächsten Knoten die Aufgabe weitergeleitet wird.

Du erhältst:
- Die Zusammenfassung des abgeschlossenen Knotens
- Die verfügbaren Zielknoten (IDs)

Antworte NUR mit gültigem JSON im Format:
{ "chosenNodeIds": ["id1"], "reason": "Kurze Begründung" }

Wähle nur Knoten, die sinnvoll zum nächsten Verarbeitungsschritt passen.`;

/**
 * LLM-gestützte Routing-Entscheidung nach Node-Abschluss.
 * Fragt das LLM, welche der ausgehenden Knotenziele aktiviert werden sollen.
 */
export async function executeLlmRouting(
  node: OrchestraGraphNode,
  candidateNodeIds: string[],
  nodeSummary: string,
): Promise<{ chosenNodeIds: string[]; reason: string }> {
  const service = getModelHubService();
  const encryptionKey = getModelHubEncryptionKey();

  const userPrompt = [
    `Knoten "${node.id}" (Persona: ${node.personaId}) ist abgeschlossen.`,
    `Zusammenfassung: ${nodeSummary || '(keine Zusammenfassung)'}`,
    '',
    `Verfügbare Zielknoten: ${candidateNodeIds.join(', ')}`,
    '',
    'Welche Zielknoten sollen als nächstes aktiviert werden?',
  ].join('\n');

  const result = await service.dispatchWithFallback('p2', encryptionKey, {
    messages: [
      { role: 'system', content: LLM_ROUTING_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
    auditContext: {
      kind: 'orchestra_routing',
      nodeId: node.id,
    },
  });

  if (!result.ok || !result.text) {
    // Fallback: activate all candidates
    return {
      chosenNodeIds: candidateNodeIds,
      reason: 'LLM-Routing fehlgeschlagen, alle Knoten aktiviert.',
    };
  }

  try {
    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { chosenNodeIds: candidateNodeIds, reason: 'Kein JSON in LLM-Antwort.' };
    }
    const parsed = JSON.parse(jsonMatch[0]) as { chosenNodeIds?: string[]; reason?: string };
    const chosen = (parsed.chosenNodeIds ?? []).filter((id) => candidateNodeIds.includes(id));
    if (chosen.length === 0) {
      return {
        chosenNodeIds: candidateNodeIds,
        reason: parsed.reason ?? 'Keine gültige Auswahl, alle aktiviert.',
      };
    }
    return { chosenNodeIds: chosen, reason: parsed.reason ?? '' };
  } catch {
    return { chosenNodeIds: candidateNodeIds, reason: 'JSON-Parse fehlgeschlagen.' };
  }
}

// ─── Command Approval ───────────────────────────────────────

/**
 * Requests approval from the user before executing a system command.
 * Pauses the task and waits for user response via /approve, /deny, /approve-always.
 */
export async function requestCommandApproval(
  taskId: string,
  command: string,
): Promise<'approved' | 'denied'> {
  const repo = getWorkerRepository();

  // Check whitelist first
  if (repo.isCommandApproved(command)) {
    return 'approved';
  }

  // Pause task and wait for user approval
  repo.saveCheckpoint(taskId, { pendingCommand: command, approvalResponse: null });
  repo.updateStatus(taskId, 'waiting_approval');

  // Poll for user response
  const maxWaitMs = 5 * 60 * 1000; // 5 minutes
  const pollIntervalMs = 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const task = repo.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status === 'cancelled') return 'denied';

    if (task.lastCheckpoint) {
      const checkpoint = JSON.parse(task.lastCheckpoint);
      if (checkpoint.approvalResponse === 'approved') {
        repo.updateStatus(taskId, 'executing');
        return 'approved';
      }
      if (checkpoint.approvalResponse === 'denied') {
        repo.updateStatus(taskId, 'executing');
        return 'denied';
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout — deny by default
  repo.updateStatus(taskId, 'executing');
  return 'denied';
}
