// ─── Server-Side Worker Agent ────────────────────────────────
// Sequential queue processor: only 1 task runs at a time.
// All other tasks wait in FIFO queue.

import { getWorkerRepository } from './workerRepository';
import { planTask } from './workerPlanner';
import { executeStep } from './workerExecutor';
import { notifyTaskCompleted, notifyTaskFailed } from './workerCallback';
import { getWorkspaceManager } from './workspaceManager';
import type { WorkerTaskRecord } from './workerTypes';
import { broadcast } from '../gateway/broadcast';
import { GatewayEvents } from '../gateway/events';

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

  // ─── Phase 1: PLANNING ──────────────────────────────────
  repo.updateStatus(task.id, 'planning');

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

  for (let i = startStepIndex; i < steps.length; i++) {
    // Check cancellation before each step
    const freshTask = repo.getTask(task.id);
    if (!freshTask || freshTask.status === 'cancelled') {
      console.log(`[Worker] Task ${task.id} was cancelled.`);
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
    broadcastStatus(task.id, 'failed', errorMsg);
    await notifyTaskFailed(task, errorMsg);
    return;
  }

  // Save plan.md to workspace
  const planMd = allSteps.map((s, i) => `- [x] ${i + 1}. ${s.description}`).join('\n');
  wsMgr.writeFile(task.id, 'plan.md', `# Plan: ${task.title}\n\n${planMd}\n`);

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
