// ─── Worker Callback ─────────────────────────────────────────
// Notifies the user when a worker task completes, fails, or needs input.

import { getMessageService } from '../channels/messages/runtime';
import { deliverOutbound } from '../channels/outbound/router';
import type { WorkerTaskRecord } from './workerTypes';

/**
 * Notify user that a task has completed successfully.
 */
export async function notifyTaskCompleted(task: WorkerTaskRecord, summary: string): Promise<void> {
  await sendNotification(task, summary);
}

/**
 * Notify user that a task has failed.
 */
export async function notifyTaskFailed(
  task: WorkerTaskRecord,
  errorMessage: string,
): Promise<void> {
  const message =
    `❌ **Task fehlgeschlagen:** "${task.title}"\n\n` +
    `Fehler: ${errorMessage}\n\n` +
    `_Du kannst den Task wiederholen:_\n` +
    `\`/worker-retry ${task.id}\``;

  await sendNotification(task, message);
}

/**
 * Notify user that the worker needs command approval.
 */
export async function notifyApprovalRequest(
  task: WorkerTaskRecord,
  command: string,
): Promise<void> {
  const message =
    `⚠️ **Worker braucht Genehmigung**\n\n` +
    `Task: "${task.title}"\n` +
    `Befehl: \`${command}\`\n\n` +
    `Antwort mit:\n` +
    `✅ \`/approve ${task.id}\` — Einmal erlauben\n` +
    `❌ \`/deny ${task.id}\` — Ablehnen\n` +
    `🔓 \`/approve-always ${task.id}\` — Immer erlauben`;

  await sendNotification(task, message);
}

/**
 * Notify user/operator that runtime switched to failover behavior.
 */
export async function notifyRuntimeFailover(
  task: WorkerTaskRecord,
  reason: string,
): Promise<void> {
  const message =
    `⚠️ **OpenAI Runtime Fallback**\n\n` +
    `Task: "${task.title}"\n` +
    `Grund: ${reason}\n\n` +
    `Status wurde auf \`interrupted\` gesetzt.`;
  await sendNotification(task, message);
}

// ─── Internal ────────────────────────────────────────────────

async function sendNotification(task: WorkerTaskRecord, message: string): Promise<void> {
  const msgService = getMessageService();

  // 1) Best effort: persist message for conversation + WS broadcast.
  try {
    msgService.saveDirectMessage(
      task.originConversation,
      'agent',
      message,
      task.originPlatform,
      task.userId || undefined,
    );
  } catch (error) {
    console.error(`[Worker Callback] Failed to persist notification for task ${task.id}:`, error);
  }

  // 2) Outbound delivery should still happen even if conversation persistence fails.
  if (!task.originExternalChat) {
    return;
  }

  try {
    await deliverOutbound(task.originPlatform, task.originExternalChat, message);
  } catch (error) {
    console.error(`[Worker Callback] Failed outbound delivery for task ${task.id}:`, error);
  }
}
