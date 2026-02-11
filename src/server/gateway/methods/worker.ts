// ─── Worker Method Handlers ──────────────────────────────────
// RPC methods for worker task operations and approval flow.

import { registerMethod, type RespondFn } from '../method-router';
import type { GatewayClient } from '../client-registry';

// ─── worker.task.list ────────────────────────────────────────
// List worker tasks, optionally filtered by status.

registerMethod(
  'worker.task.list',
  async (params: Record<string, unknown>, _client: GatewayClient, respond: RespondFn, _ctx) => {
    const { getWorkerRepository } = await import('../../worker/workerRepository');
    const repo = getWorkerRepository();
    const filter: { status?: string; limit?: number } = {};
    if (params.status) filter.status = params.status as string;
    if (params.limit) filter.limit = Number(params.limit);
    const tasks = repo.listTasks(filter as Parameters<typeof repo.listTasks>[0]);
    respond(tasks);
  },
);

// ─── worker.task.get ─────────────────────────────────────────
// Get details for a specific worker task.

registerMethod(
  'worker.task.get',
  async (params: Record<string, unknown>, _client: GatewayClient, respond: RespondFn, _ctx) => {
    const taskId = params.taskId as string;
    if (!taskId) throw new Error('taskId is required');

    const { getWorkerRepository } = await import('../../worker/workerRepository');
    const repo = getWorkerRepository();
    const task = repo.getTask(taskId);
    if (!task) throw new Error('Task not found');
    respond(task);
  },
);

// ─── worker.task.subscribe ───────────────────────────────────
// Subscribe to status updates for a specific task.

registerMethod(
  'worker.task.subscribe',
  (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const taskId = params.taskId as string;
    if (!taskId) throw new Error('taskId is required');

    client.subscriptions.add(`worker:${taskId}`);
    respond({ subscribed: true, taskId });
  },
);

// ─── worker.task.unsubscribe ─────────────────────────────────

registerMethod(
  'worker.task.unsubscribe',
  (params: Record<string, unknown>, client: GatewayClient, respond: RespondFn, _ctx) => {
    const taskId = params.taskId as string;
    if (!taskId) throw new Error('taskId is required');

    client.subscriptions.delete(`worker:${taskId}`);
    respond({ unsubscribed: true, taskId });
  },
);

// ─── worker.approval.respond ─────────────────────────────────
// Respond to a command approval request from the worker agent.
// Updates the checkpoint's approvalResponse field so the executor's
// polling loop in requestCommandApproval() picks it up.

registerMethod(
  'worker.approval.respond',
  async (params: Record<string, unknown>, _client: GatewayClient, respond: RespondFn, _ctx) => {
    const taskId = params.taskId as string;
    const approved = params.approved as boolean;
    const approveAlways = params.approveAlways as boolean | undefined;

    if (!taskId || typeof approved !== 'boolean') {
      throw new Error('taskId and approved (boolean) are required');
    }

    const { getWorkerRepository } = await import('../../worker/workerRepository');
    const repo = getWorkerRepository();

    const task = repo.getTask(taskId);
    if (!task) throw new Error('Task not found');

    // Parse existing checkpoint to preserve pendingCommand
    const checkpoint = task.lastCheckpoint ? JSON.parse(task.lastCheckpoint) : {};
    checkpoint.approvalResponse = approved ? 'approved' : 'denied';
    repo.saveCheckpoint(taskId, checkpoint);

    // If approveAlways, whitelist the command
    if (approved && approveAlways && checkpoint.pendingCommand) {
      repo.addApprovalRule(checkpoint.pendingCommand);
    }

    respond({ taskId, approved });
  },
);
