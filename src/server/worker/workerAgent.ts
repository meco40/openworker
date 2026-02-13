// ─── Server-Side Worker Agent ────────────────────────────────
// Sequential queue processor: only 1 task runs at a time.
// All other tasks wait in FIFO queue.

import { getWorkerRepository } from './workerRepository';
import { planTask } from './workerPlanner';
import { executeOrchestraNode, executeStep } from './workerExecutor';
import { notifyTaskCompleted, notifyTaskFailed } from './workerCallback';
import { getWorkspaceManager } from './workspaceManager';
import { runWebappTests } from './workerTester';
import type { WorkerTaskRecord } from './workerTypes';
import type { OrchestraFlowGraph } from './orchestraGraph';
import { runOrchestraFlow } from './orchestraRunner';
import { buildNodeStatusMap, buildWorkerWorkflowPayload } from './orchestraWorkflow';
import { broadcast } from '../gateway/broadcast';
import { GatewayEvents } from '../gateway/events';
import { LEGACY_LOCAL_USER_ID } from '../auth/constants';

// ─── Queue Processor ─────────────────────────────────────────

let isProcessing = false;

/**
 * Processes the task queue sequentially. Only one task at a time.
 * Safe to call multiple times — will no-op if already processing.
 */
export async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const repo = getWorkerRepository();

    while (true) {
      const task = repo.getNextQueuedTask();
      if (!task) break;

      try {
        await runWorkerAgent(task);
      } catch (error) {
        console.error(`[Worker] Task ${task.id} failed:`, error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        repo.updateStatus(task.id, 'failed', { error: errorMsg });
        await notifyTaskFailed(task, errorMsg);
      }
    }
  } finally {
    isProcessing = false;
  }
}

// ─── Worker Agent Main Loop ──────────────────────────────────

async function runWorkerAgent(task: WorkerTaskRecord): Promise<void> {
  const repo = getWorkerRepository();

  // Check if resuming from checkpoint
  let startStepIndex = 0;
  if (task.lastCheckpoint) {
    try {
      const checkpoint = JSON.parse(task.lastCheckpoint);
      if (checkpoint.phase === 'executing' && typeof checkpoint.stepIndex === 'number') {
        startStepIndex = checkpoint.stepIndex;
      }
    } catch {
      // Ignore invalid checkpoint
    }
  }

  // ─── Phase 0: WORKSPACE SETUP ─────────────────────────
  const wsMgr = getWorkspaceManager();
  const wsType = task.workspaceType || 'general';
  let wsPath: string;

  if (wsMgr.exists(task.id)) {
    wsPath = wsMgr.getWorkspacePath(task.id);
  } else {
    wsPath = wsMgr.createWorkspace(task.id, wsType);
    repo.setWorkspacePath(task.id, wsPath);
  }
  broadcastStatus(task.id, 'planning', 'Workspace erstellt. Aufgabe wird analysiert...');

  // ─── Orchestra Path (published flow attached) ──────────────
  if (task.flowPublishedId) {
    const userId = task.userId || LEGACY_LOCAL_USER_ID;
    const publishedFlow = repo.getFlowPublished(task.flowPublishedId, userId);
    if (!publishedFlow) {
      repo.updateStatus(task.id, 'failed', {
        error: `Published flow ${task.flowPublishedId} not found`,
      });
      await notifyTaskFailed(task, `Flow ${task.flowPublishedId} nicht gefunden.`);
      return;
    }

    let graph: OrchestraFlowGraph;
    try {
      graph = JSON.parse(publishedFlow.graphJson) as OrchestraFlowGraph;
    } catch {
      repo.updateStatus(task.id, 'failed', {
        error: `Published flow ${publishedFlow.id} has invalid graph JSON`,
      });
      await notifyTaskFailed(task, `Flow ${publishedFlow.id} enthält ungültiges Graph-JSON.`);
      return;
    }

    repo.updateStatus(task.id, 'executing');
    repo.addActivity({
      taskId: task.id,
      type: 'status_change',
      message: `Orchestra-Ausführung gestartet (${publishedFlow.name} v${publishedFlow.version})`,
      metadata: { from: 'queued', to: 'executing', flowPublishedId: publishedFlow.id },
    });

    const run = repo.createRun({
      taskId: task.id,
      userId,
      flowPublishedId: publishedFlow.id,
      status: 'running',
    });
    repo.setTaskRunContext(task.id, { flowPublishedId: publishedFlow.id, currentRunId: run.id });

    const broadcastWorkflow = () => {
      const nodeStatuses = buildNodeStatusMap(repo.listRunNodes(run.id));
      const payload = buildWorkerWorkflowPayload({
        taskId: task.id,
        runId: run.id,
        flowPublishedId: publishedFlow.id,
        graph,
        nodeStatuses,
      });
      broadcast(GatewayEvents.WORKER_WORKFLOW, payload);
    };

    const runResult = await runOrchestraFlow({
      taskId: task.id,
      flowPublishedId: publishedFlow.id,
      graph,
      executeNode: async (nodeId: string) => {
        const node = graph.nodes.find((candidate) => candidate.id === nodeId);
        repo.upsertRunNodeStatus(run.id, nodeId, {
          personaId: node?.personaId || null,
          status: 'running',
        });
        broadcastWorkflow();
        repo.addActivity({
          taskId: task.id,
          type: 'note',
          message: `Orchestra-Node gestartet: ${nodeId}`,
          metadata: { nodeId, runId: run.id },
        });

        try {
          const stepResult = await executeOrchestraNode(task, {
            id: nodeId,
            description: node ? `Node ${nodeId} (${node.personaId})` : `Node ${nodeId}`,
          });

          repo.upsertRunNodeStatus(run.id, nodeId, {
            personaId: node?.personaId || null,
            status: 'completed',
            outputSummary: stepResult.output,
          });
          broadcastWorkflow();

          repo.addActivity({
            taskId: task.id,
            type: 'step_completed',
            message: `Orchestra-Node abgeschlossen: ${nodeId}`,
            metadata: { nodeId, runId: run.id },
          });

          return { summary: stepResult.output };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          repo.upsertRunNodeStatus(run.id, nodeId, {
            personaId: node?.personaId || null,
            status: 'failed',
            errorMessage: message,
          });
          broadcastWorkflow();
          throw error;
        }
      },
    });

    for (const [nodeId, nodeState] of Object.entries(runResult.nodes)) {
      if (nodeState.status === 'running') continue;
      repo.upsertRunNodeStatus(run.id, nodeId, {
        status: nodeState.status,
        errorMessage: nodeState.error,
        outputSummary: nodeState.summary,
      });
    }
    broadcastWorkflow();

    if (runResult.status === 'failed') {
      const failedNode = Object.entries(runResult.nodes).find(([, state]) => state.status === 'failed');
      const failReason =
        failedNode?.[1].error || `Orchestra run ${run.id} failed (flow ${publishedFlow.id})`;
      repo.updateRunStatus(run.id, { status: 'failed', errorMessage: failReason });
      repo.updateStatus(task.id, 'failed', { error: failReason });
      repo.addActivity({
        taskId: task.id,
        type: 'error',
        message: `Orchestra fehlgeschlagen: ${failReason}`,
        metadata: { runId: run.id, flowPublishedId: publishedFlow.id },
      });
      await notifyTaskFailed(task, failReason);
      return;
    }

    repo.updateRunStatus(run.id, { status: 'completed' });
    const summary = `✅ Orchestra-Task "${task.title}" abgeschlossen (${publishedFlow.name} v${publishedFlow.version}).`;
    repo.updateStatus(task.id, 'completed', { summary });
    repo.addActivity({
      taskId: task.id,
      type: 'status_change',
      message: `Task abgeschlossen via Orchestra — ${Object.keys(runResult.nodes).length} Nodes`,
      metadata: { from: 'executing', to: 'completed', runId: run.id },
    });
    await notifyTaskCompleted(task, summary);
    return;
  }

  // ─── Phase 1: PLANNING ──────────────────────────────────
  repo.updateStatus(task.id, 'planning');
  repo.addActivity({
    taskId: task.id,
    type: 'status_change',
    message: 'Planung gestartet',
    metadata: { from: 'queued', to: 'planning' },
  });

  const plan = await planTask(task);

  if (!plan.steps || plan.steps.length === 0) {
    repo.updateStatus(task.id, 'failed', { error: 'Planner returned no steps' });
    await notifyTaskFailed(task, 'Konnte keinen Plan erstellen.');
    return;
  }

  // Save steps to DB
  repo.saveSteps(
    task.id,
    plan.steps.map((desc: string, i: number) => ({
      taskId: task.id,
      stepIndex: i,
      description: desc,
    })),
  );
  repo.saveCheckpoint(task.id, { phase: 'executing', stepIndex: startStepIndex });

  // ─── Phase 2: EXECUTION ─────────────────────────────────
  repo.updateStatus(task.id, 'executing');
  const steps = repo.getSteps(task.id);
  repo.addActivity({
    taskId: task.id,
    type: 'status_change',
    message: `Ausführung gestartet — ${steps.length} Schritte geplant`,
    metadata: { from: 'planning', to: 'executing', totalSteps: steps.length },
  });

  for (let i = startStepIndex; i < steps.length; i++) {
    // Check cancellation before each step
    const freshTask = repo.getTask(task.id);
    if (!freshTask || freshTask.status !== 'executing') {
      // Task was cancelled, moved, or externally modified — stop processing
      console.log(
        `[Worker] Task ${task.id} status changed to '${freshTask?.status ?? 'deleted'}' — stopping.`,
      );
      if (freshTask && freshTask.status !== 'cancelled' && freshTask.status !== 'failed') {
        repo.updateStatus(task.id, 'interrupted', {
          error: 'Task status changed externally during execution',
        });
      }
      return;
    }

    const step = steps[i];
    repo.setCurrentStep(task.id, i);
    repo.updateStepStatus(step.id, 'running');
    broadcastStatus(task.id, 'executing', `Schritt ${i + 1}/${steps.length}: ${step.description}`);

    try {
      const result = await executeStep(task, step);

      repo.updateStepStatus(
        step.id,
        'completed',
        result.output,
        result.toolCalls ? JSON.stringify(result.toolCalls) : undefined,
      );

      repo.addActivity({
        taskId: task.id,
        type: 'step_completed',
        message: `Schritt ${i + 1}/${steps.length} abgeschlossen: ${step.description}`,
        metadata: { stepIndex: i, stepId: step.id },
      });

      // Save checkpoint after each step
      repo.saveCheckpoint(task.id, { phase: 'executing', stepIndex: i + 1 });

      // Save step log to workspace
      const stepLog = `# Step ${i + 1}: ${step.description}\n\n${result.output || '(no output)'}\n`;
      wsMgr.writeFile(task.id, `logs/step-${String(i + 1).padStart(3, '0')}.log`, stepLog);

      // Save any artifacts to DB + workspace files
      if (result.artifacts) {
        for (const art of result.artifacts) {
          repo.saveArtifact({
            taskId: task.id,
            name: art.name,
            type: art.type,
            content: art.content,
            mimeType: art.mimeType,
          });
          // Also write artifact as real file in workspace
          wsMgr.writeFile(task.id, `output/${art.name}`, art.content);
        }
      }

      // Broadcast file update for live refresh
      broadcastStatus(task.id, 'executing', `Schritt ${i + 1}/${steps.length} abgeschlossen`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      repo.updateStepStatus(step.id, 'failed', errorMsg);
      repo.addActivity({
        taskId: task.id,
        type: 'step_failed',
        message: `Schritt ${i + 1} fehlgeschlagen: ${errorMsg}`,
        metadata: { stepIndex: i, stepId: step.id },
      });
      repo.updateStatus(task.id, 'failed', {
        error: `Schritt ${i + 1} fehlgeschlagen: ${errorMsg}`,
      });
      await notifyTaskFailed(task, `Schritt ${i + 1} fehlgeschlagen: ${errorMsg}`);
      return;
    }
  }

  // ─── Phase 3: SELF-VERIFY ───────────────────────────────
  broadcastStatus(task.id, 'executing', 'Selbstüberprüfung...');

  const allSteps = repo.getSteps(task.id);
  const failedSteps = allSteps.filter((s) => s.status === 'failed');

  if (failedSteps.length > 0) {
    const errorMsg = `${failedSteps.length} Schritt(e) fehlgeschlagen: ${failedSteps.map((s) => s.description).join(', ')}`;
    repo.updateStatus(task.id, 'failed', { error: errorMsg });
    repo.addActivity({
      taskId: task.id,
      type: 'error',
      message: `Selbstüberprüfung fehlgeschlagen: ${errorMsg}`,
      metadata: { failedStepCount: failedSteps.length },
    });
    broadcastStatus(task.id, 'failed', errorMsg);
    await notifyTaskFailed(task, errorMsg);
    return;
  }

  // Save plan.md to workspace
  const planMd = allSteps.map((s, i) => `- [x] ${i + 1}. ${s.description}`).join('\n');
  wsMgr.writeFile(task.id, 'plan.md', `# Plan: ${task.title}\n\n${planMd}\n`);

  // ─── Phase 3b: AUTOMATED TESTING (webapp only) ──────────
  if (wsType === 'webapp') {
    repo.updateStatus(task.id, 'testing');
    repo.addActivity({
      taskId: task.id,
      type: 'status_change',
      message: 'Automatische Tests gestartet',
      metadata: { from: 'executing', to: 'testing' },
    });
    broadcastStatus(task.id, 'testing', 'Automatische Tests werden ausgeführt...');

    const testResult = runWebappTests(wsPath);

    // Save test results to workspace
    const testReport = testResult.results
      .map((r) => `${r.passed ? '✅' : '❌'} ${r.name}: ${r.message}`)
      .join('\n');
    wsMgr.writeFile(task.id, 'test-results.md', `# Testergebnisse\n\n${testReport}\n`);

    repo.addActivity({
      taskId: task.id,
      type: 'note',
      message: testResult.passed
        ? `Alle ${testResult.total} Tests bestanden`
        : `${testResult.failed}/${testResult.total} Tests fehlgeschlagen`,
      metadata: { total: testResult.total, failed: testResult.failed },
    });

    if (!testResult.passed) {
      broadcastStatus(task.id, 'testing', `${testResult.failed} Tests fehlgeschlagen`);
      // Move to review for human inspection
      repo.updateStatus(task.id, 'review', {
        summary: `⚠️ ${testResult.failed}/${testResult.total} Tests fehlgeschlagen.\n\n${testReport}`,
      });
      repo.addActivity({
        taskId: task.id,
        type: 'status_change',
        message: 'Zur manuellen Überprüfung verschoben',
        metadata: { from: 'testing', to: 'review', reason: 'tests_failed' },
      });
      broadcastStatus(
        task.id,
        'review',
        'Tests fehlgeschlagen — manuelle Überprüfung erforderlich',
      );
      return;
    }

    broadcastStatus(task.id, 'testing', 'Alle Tests bestanden');
  }

  // ─── Phase 4: REVIEW & COMPLETE ─────────────────────────
  const summaryParts = allSteps
    .filter((s) => s.output)
    .map((s, i) => `${i + 1}. ${s.description}: ${s.output}`);

  const artifacts = repo.getArtifacts(task.id);
  const wsFiles = wsMgr.listFiles(task.id).filter((f) => !f.isDirectory);
  const summary =
    `✅ Task "${task.title}" abgeschlossen.\n\n` +
    `**Schritte:**\n${summaryParts.join('\n')}\n\n` +
    (artifacts.length > 0 ? `**Artefakte:** ${artifacts.map((a) => a.name).join(', ')}\n` : '') +
    `**Workspace:** ${wsFiles.length} Dateien (${Math.round(wsMgr.getWorkspaceSize(task.id) / 1024)} KB)`;

  repo.updateStatus(task.id, 'completed', { summary });
  repo.addActivity({
    taskId: task.id,
    type: 'status_change',
    message: `Task abgeschlossen — ${allSteps.length} Schritte, ${artifacts.length} Artefakte`,
    metadata: { from: 'executing', to: 'completed', artifactCount: artifacts.length },
  });
  broadcastStatus(task.id, 'completed', 'Task abgeschlossen');
  await notifyTaskCompleted(task, summary);
}

// ─── Worker Status Broadcast ─────────────────────────────────

function broadcastStatus(taskId: string, status: string, message: string): void {
  const payload = { taskId, status, message, timestamp: new Date().toISOString() };
  broadcast(GatewayEvents.WORKER_STATUS, payload);
}

// ─── Graceful Shutdown ───────────────────────────────────────

function handleShutdown(): void {
  const repo = getWorkerRepository();
  const activeTask = repo.getActiveTask();
  if (activeTask) {
    console.log(`[Worker] Marking task ${activeTask.id} as interrupted for resume.`);
    repo.markInterrupted(activeTask.id);
  }
}

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);
