// ─── Worker Status Broadcast ─────────────────────────────────
// Centralized status broadcasting utilities for the worker agent.

import { broadcast } from '../../gateway/broadcast';
import { GatewayEvents } from '../../gateway/events';
import type { WorkerWorkflowPayload } from '../orchestraWorkflow';

/**
 * Broadcasts a status update for a specific task to all connected clients.
 */
export function broadcastStatus(taskId: string, status: string, message: string): void {
  const payload = {
    taskId,
    status,
    message,
    timestamp: new Date().toISOString(),
    source: 'legacy' as const,
  };
  broadcast(GatewayEvents.WORKER_STATUS, payload);
}

/**
 * Normalizes OpenAI sidecar progress into the existing worker.status contract.
 */
export function broadcastOpenAiStatus(
  taskId: string,
  status: string,
  message: string,
  runId?: string | null,
): void {
  const payload = {
    taskId,
    status,
    message,
    runId: runId ?? null,
    timestamp: new Date().toISOString(),
    source: 'openai' as const,
  };
  broadcast(GatewayEvents.WORKER_STATUS, payload);
}

/**
 * Broadcasts a workflow update for Orchestra flows.
 */
export function broadcastWorkflowUpdate(payload: WorkerWorkflowPayload): void {
  broadcast(GatewayEvents.WORKER_WORKFLOW, payload);
}
