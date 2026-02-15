// ─── Standard Task Phase ─────────────────────────────────────
// Handles standard (non-Orchestra) task execution: planning, execution,
// verification, testing, and completion.

import { getWorkerRepository } from '../workerRepository';
import { planTask } from '../workerPlanner';
import { executeStep } from '../workerExecutor';
import { getWorkspaceManager } from '../workspaceManager';
import { runWebappTests } from '../workerTester';
import { broadcastStatus } from '../utils/broadcast';
import type { WorkerTaskRecord, WorkerStepRecord } from '../workerTypes';
import type { WorkspaceType } from '../workspaceManager';

/**
 * Executes a standard task through all phases: planning, execution,
 * verification, testing (if webapp), and completion.
 */
export async function executeStandardTaskPhase(
  task: WorkerTaskRecord,
  startStepIndex: number,
  workspaceType: WorkspaceType,
): Promise<void> {
  const repo = getWorkerRepository();

  // ─── Phase 1: PLANNING ───────────────────────────────────
  const plan = await executePlanningPhase(task);
  if (!plan) return; // Planning failed

  const steps = repo.getSteps(task.id);
  repo.saveCheckpoint(task.id, { phase: 'executing', stepIndex: startStepIndex });

  // ─── Phase 2: EXECUTION ──────────────────────────────────
  const executionResult = await executeExecutionPhase(task, steps, startStepIndex);
  if (!executionResult.success) return; // Execution failed

  // ─── Phase 3: SELF-VERIFY ────────────────────────────────
  const verificationResult = await executeVerificationPhase(task);
  if (!verificationResult.success) return; // Verification failed

  // ─── Phase 3b: AUTOMATED TESTING (webapp only) ───────────
  if (workspaceType === 'webapp') {
    const testResult = await executeTestingPhase(task);
    if (!testResult.success) return; // Tests failed, moved to review
  }

  // ─── Phase 4: REVIEW & COMPLETE ──────────────────────────
  await executeCompletionPhase(task, steps);
}

// ─── Phase Implementations ───────────────────────────────────

interface PlanningResult {
  success: boolean;
  steps?: string[];
}

async function executePlanningPhase(task: WorkerTaskRecord): Promise<PlanningResult | null> {
  const repo = getWorkerRepository();

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
    await notifyFailed(task, 'Konnte keinen Plan erstellen.');
    return null;
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

  return { success: true, steps: plan.steps };
}

interface ExecutionResult {
  success: boolean;
}

async function executeExecutionPhase(
  task: WorkerTaskRecord,
  steps: WorkerStepRecord[],
  startStepIndex: number,
): Promise<ExecutionResult> {
  const repo = getWorkerRepository();

  repo.updateStatus(task.id, 'executing');
  repo.addActivity({
    taskId: task.id,
    type: 'status_change',
    message: `Ausführung gestartet — ${steps.length} Schritte geplant`,
    metadata: { from: 'planning', to: 'executing', totalSteps: steps.length },
  });

  for (let i = startStepIndex; i < steps.length; i++) {
    // Check for cancellation before each step
    const shouldContinue = await checkTaskStillExecuting(task);
    if (!shouldContinue) return { success: false };

    const step = steps[i];
    const stepSuccess = await executeSingleStep(task, step, i, steps.length);
    if (!stepSuccess) return { success: false };
  }

  return { success: true };
}

async function checkTaskStillExecuting(task: WorkerTaskRecord): Promise<boolean> {
  const repo = getWorkerRepository();
  const freshTask = repo.getTask(task.id);

  if (!freshTask || freshTask.status !== 'executing') {
    console.log(
      `[Worker] Task ${task.id} status changed to '${freshTask?.status ?? 'deleted'}' — stopping.`,
    );
    if (freshTask && freshTask.status !== 'cancelled' && freshTask.status !== 'failed') {
      repo.updateStatus(task.id, 'interrupted', {
        error: 'Task status changed externally during execution',
      });
    }
    return false;
  }
  return true;
}

async function executeSingleStep(
  task: WorkerTaskRecord,
  step: WorkerStepRecord,
  index: number,
  totalSteps: number,
): Promise<boolean> {
  const repo = getWorkerRepository();
  const wsMgr = getWorkspaceManager();

  repo.setCurrentStep(task.id, index);
  repo.updateStepStatus(step.id, 'running');
  broadcastStatus(task.id, 'executing', `Schritt ${index + 1}/${totalSteps}: ${step.description}`);

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
      message: `Schritt ${index + 1}/${totalSteps} abgeschlossen: ${step.description}`,
      metadata: { stepIndex: index, stepId: step.id },
    });

    // Save checkpoint after each step
    repo.saveCheckpoint(task.id, { phase: 'executing', stepIndex: index + 1 });

    // Save step log to workspace
    const stepLog = `# Step ${index + 1}: ${step.description}\n\n${result.output || '(no output)'}\n`;
    wsMgr.writeFile(task.id, `logs/step-${String(index + 1).padStart(3, '0')}.log`, stepLog);

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
        wsMgr.writeFile(task.id, `output/${art.name}`, art.content);
      }
    }

    broadcastStatus(task.id, 'executing', `Schritt ${index + 1}/${totalSteps} abgeschlossen`);
    return true;
  } catch (error) {
    await handleStepError(task, step, index, error);
    return false;
  }
}

async function handleStepError(
  task: WorkerTaskRecord,
  step: WorkerStepRecord,
  index: number,
  error: unknown,
): Promise<void> {
  const repo = getWorkerRepository();
  const errorMsg = error instanceof Error ? error.message : String(error);

  repo.updateStepStatus(step.id, 'failed', errorMsg);
  repo.addActivity({
    taskId: task.id,
    type: 'step_failed',
    message: `Schritt ${index + 1} fehlgeschlagen: ${errorMsg}`,
    metadata: { stepIndex: index, stepId: step.id },
  });
  repo.updateStatus(task.id, 'failed', {
    error: `Schritt ${index + 1} fehlgeschlagen: ${errorMsg}`,
  });
  await notifyFailed(task, `Schritt ${index + 1} fehlgeschlagen: ${errorMsg}`);
}

interface VerificationResult {
  success: boolean;
}

async function executeVerificationPhase(task: WorkerTaskRecord): Promise<VerificationResult> {
  const repo = getWorkerRepository();

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
    await notifyFailed(task, errorMsg);
    return { success: false };
  }

  // Save plan.md to workspace
  const planMd = allSteps.map((s, i) => `- [x] ${i + 1}. ${s.description}`).join('\n');
  const wsMgr = getWorkspaceManager();
  wsMgr.writeFile(task.id, 'plan.md', `# Plan: ${task.title}\n\n${planMd}\n`);

  return { success: true };
}

interface TestingResult {
  success: boolean;
}

async function executeTestingPhase(task: WorkerTaskRecord): Promise<TestingResult> {
  const repo = getWorkerRepository();
  const wsMgr = getWorkspaceManager();
  const wsPath = wsMgr.getWorkspacePath(task.id);

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
    repo.updateStatus(task.id, 'review', {
      summary: `⚠️ ${testResult.failed}/${testResult.total} Tests fehlgeschlagen.\n\n${testReport}`,
    });
    repo.addActivity({
      taskId: task.id,
      type: 'status_change',
      message: 'Zur manuellen Überprüfung verschoben',
      metadata: { from: 'testing', to: 'review', reason: 'tests_failed' },
    });
    broadcastStatus(task.id, 'review', 'Tests fehlgeschlagen — manuelle Überprüfung erforderlich');
    return { success: false }; // Moved to review, not completed
  }

  broadcastStatus(task.id, 'testing', 'Alle Tests bestanden');
  return { success: true };
}

async function executeCompletionPhase(
  task: WorkerTaskRecord,
  steps: WorkerStepRecord[],
): Promise<void> {
  const repo = getWorkerRepository();
  const wsMgr = getWorkspaceManager();

  const summaryParts = steps
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
    message: `Task abgeschlossen — ${steps.length} Schritte, ${artifacts.length} Artefakte`,
    metadata: { from: 'executing', to: 'completed', artifactCount: artifacts.length },
  });
  broadcastStatus(task.id, 'completed', 'Task abgeschlossen');
  await notifyCompleted(task, summary);
}

async function notifyCompleted(task: WorkerTaskRecord, summary: string): Promise<void> {
  const { notifyTaskCompleted } = await import('../workerCallback');
  await notifyTaskCompleted(task, summary);
}

async function notifyFailed(task: WorkerTaskRecord, message: string): Promise<void> {
  const { notifyTaskFailed } = await import('../workerCallback');
  await notifyTaskFailed(task, message);
}
