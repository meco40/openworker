// ─── Worker Status Broadcast ─────────────────────────────────
// Centralized status broadcasting utilities for the worker agent.

import { broadcast } from '../../gateway/broadcast';
import { GatewayEvents } from '../../gateway/events';
import type { WorkerWorkflowPayload } from '../orchestraWorkflow';

/**
 * Broadcasts a status update for a specific task to all connected clients.
 */
export function broadcastStatus(taskId: string, status: string, message: string): void {
  const payload = { taskId, status, message, timestamp: new Date().toISOString() };
  broadcast(GatewayEvents.WORKER_STATUS, payload);
}

/**
 * Broadcasts a workflow update for Orchestra flows.
 */
export function broadcastWorkflowUpdate(payload: WorkerWorkflowPayload): void {
  broadcast(GatewayEvents.WORKER_WORKFLOW, payload);
}
