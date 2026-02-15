// ─── Orchestra Phase ─────────────────────────────────────────
// Handles execution of Orchestra flows (published flow graphs).

import type { WorkerTaskRecord } from '../workerTypes';
import type { OrchestraFlowGraph } from '../orchestraGraph';
import { getWorkerRepository } from '../workerRepository';
import { executeOrchestraNode, executeLlmRouting } from '../workerExecutor';
import { runOrchestraFlow } from '../orchestraRunner';
import { buildNodeStatusMap, buildWorkerWorkflowPayload } from '../orchestraWorkflow';
import { broadcastWorkflowUpdate } from '../utils/broadcast';
import { LEGACY_LOCAL_USER_ID } from '../../auth/constants';

/**
 * Executes a task using an Orchestra flow.
 * Returns true if the task was handled (completed or failed), false otherwise.
 */
export async function executeOrchestraPhase(task: WorkerTaskRecord): Promise<boolean> {
  if (!task.flowPublishedId) {
    return false; // Not an orchestra task, proceed with standard execution
  }

  const repo = getWorkerRepository();
  const userId = task.userId || LEGACY_LOCAL_USER_ID;

  // Load the published flow
  const publishedFlow = repo.getFlowPublished(task.flowPublishedId, userId);
  if (!publishedFlow) {
    await handleFlowNotFound(task);
    return true;
  }

  // Parse the flow graph
  let graph: OrchestraFlowGraph;
  try {
    graph = JSON.parse(publishedFlow.graphJson) as OrchestraFlowGraph;
  } catch {
    await handleInvalidGraph(task, publishedFlow.id);
    return true;
  }

  // Initialize run
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

  // Create broadcast helper
  const broadcastWorkflow = () => {
    const nodeStatuses = buildNodeStatusMap(repo.listRunNodes(run.id));
    const payload = buildWorkerWorkflowPayload({
      taskId: task.id,
      runId: run.id,
      flowPublishedId: publishedFlow.id,
      graph,
      nodeStatuses,
    });
    broadcastWorkflowUpdate(payload);
  };

  // Execute the flow
  const runResult = await runOrchestraFlow({
    taskId: task.id,
    flowPublishedId: publishedFlow.id,
    graph,
    decideLlmRouting: executeLlmRouting,
    executeNode: async (nodeId: string) =>
      executeNode(nodeId, graph, run.id, task, broadcastWorkflow),
  });

  // Update final node statuses
  for (const [nodeId, nodeState] of Object.entries(runResult.nodes)) {
    if (nodeState.status === 'running') continue;
    repo.upsertRunNodeStatus(run.id, nodeId, {
      status: nodeState.status,
      errorMessage: nodeState.error,
      outputSummary: nodeState.summary,
    });
  }
  broadcastWorkflow();

  // Handle result
  if (runResult.status === 'failed') {
    await handleOrchestraFailure(task, run.id, publishedFlow.id, runResult.nodes);
    return true;
  }

  await handleOrchestraSuccess(task, run.id, publishedFlow, runResult.nodes);
  return true;
}

/**
 * Executes a single node within an Orchestra flow.
 */
async function executeNode(
  nodeId: string,
  graph: OrchestraFlowGraph,
  runId: string,
  task: WorkerTaskRecord,
  broadcastWorkflow: () => void,
): Promise<{ summary?: string }> {
  const repo = getWorkerRepository();
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);

  repo.upsertRunNodeStatus(runId, nodeId, {
    personaId: node?.personaId || null,
    status: 'running',
  });
  broadcastWorkflow();

  repo.addActivity({
    taskId: task.id,
    type: 'note',
    message: `Orchestra-Node gestartet: ${nodeId}`,
    metadata: { nodeId, runId },
  });

  try {
    const stepResult = await executeOrchestraNode(task, {
      id: nodeId,
      description: node ? `Node ${nodeId} (${node.personaId})` : `Node ${nodeId}`,
      skillIds: node?.skillIds,
    });

    repo.upsertRunNodeStatus(runId, nodeId, {
      personaId: node?.personaId || null,
      status: 'completed',
      outputSummary: stepResult.output,
    });
    broadcastWorkflow();

    repo.addActivity({
      taskId: task.id,
      type: 'step_completed',
      message: `Orchestra-Node abgeschlossen: ${nodeId}`,
      metadata: { nodeId, runId },
    });

    return { summary: stepResult.output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    repo.upsertRunNodeStatus(runId, nodeId, {
      personaId: node?.personaId || null,
      status: 'failed',
      errorMessage: message,
    });
    broadcastWorkflow();
    throw error;
  }
}

// ─── Error Handlers ──────────────────────────────────────────

async function handleFlowNotFound(task: WorkerTaskRecord): Promise<void> {
  const repo = getWorkerRepository();
  const error = `Published flow ${task.flowPublishedId} not found`;
  repo.updateStatus(task.id, 'failed', { error });
  await notifyFailed(task, `Flow ${task.flowPublishedId} nicht gefunden.`);
}

async function handleInvalidGraph(task: WorkerTaskRecord, flowId: string): Promise<void> {
  const repo = getWorkerRepository();
  const error = `Published flow ${flowId} has invalid graph JSON`;
  repo.updateStatus(task.id, 'failed', { error });
  await notifyFailed(task, `Flow ${flowId} enthält ungültiges Graph-JSON.`);
}

async function handleOrchestraFailure(
  task: WorkerTaskRecord,
  runId: string,
  flowPublishedId: string,
  nodes: Record<string, { status: string; error?: string | null }>,
): Promise<void> {
  const repo = getWorkerRepository();
  const failedNode = Object.entries(nodes).find(([, state]) => state.status === 'failed');
  const failReason =
    failedNode?.[1].error || `Orchestra run ${runId} failed (flow ${flowPublishedId})`;

  repo.updateRunStatus(runId, { status: 'failed', errorMessage: failReason });
  repo.updateStatus(task.id, 'failed', { error: failReason });
  repo.addActivity({
    taskId: task.id,
    type: 'error',
    message: `Orchestra fehlgeschlagen: ${failReason}`,
    metadata: { runId, flowPublishedId },
  });
  await notifyFailed(task, failReason);
}

async function handleOrchestraSuccess(
  task: WorkerTaskRecord,
  runId: string,
  publishedFlow: { id: string; name: string; version: number },
  nodes: Record<string, unknown>,
): Promise<void> {
  const repo = getWorkerRepository();
  repo.updateRunStatus(runId, { status: 'completed' });
  const summary = `✅ Orchestra-Task "${task.title}" abgeschlossen (${publishedFlow.name} v${publishedFlow.version}).`;
  repo.updateStatus(task.id, 'completed', { summary });
  repo.addActivity({
    taskId: task.id,
    type: 'status_change',
    message: `Task abgeschlossen via Orchestra — ${Object.keys(nodes).length} Nodes`,
    metadata: { from: 'executing', to: 'completed', runId },
  });
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
