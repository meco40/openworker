import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';
import {
  ensureTaskDeliverablesFromProjectDir,
  triggerAutomatedTaskTest,
} from '@/server/tasks/autoTesting';
import { extractTaskCompleteSummary } from './message';
import type {
  DispatchChatSendResult,
  DispatchHttpResponse,
  PreparedDispatchContext,
} from './types';

function buildDispatchSuccessPayload(params: PreparedDispatchContext): Record<string, unknown> {
  const { task, agent, session } = params;
  return {
    success: true,
    task_id: task.id,
    agent_id: agent.id,
    session_id: session.openclaw_session_id,
    message: 'Task dispatched to agent',
  };
}

export function finalizeDispatch(
  context: PreparedDispatchContext,
  sendResult: DispatchChatSendResult | null,
): DispatchHttpResponse {
  const { taskId, task, agent, session, taskProjectDir, now } = context;
  const completionSummary = extractTaskCompleteSummary(sendResult?.agentContent);

  if (completionSummary) {
    const shouldAutoTest = task.status !== 'review' && task.status !== 'done';
    if (task.status !== 'testing' && task.status !== 'review' && task.status !== 'done') {
      run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['testing', now, taskId]);
    }

    if (shouldAutoTest) {
      ensureTaskDeliverablesFromProjectDir({
        taskId: task.id,
        taskTitle: task.title,
        projectDir: taskProjectDir,
      });
      triggerAutomatedTaskTest(task.id);
    }

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) {
      broadcast({
        type: 'task_updated',
        payload: updatedTask,
      });
    }

    run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['standby', now, agent.id]);

    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        'task_dispatched',
        agent.id,
        task.id,
        `Task "${task.title}" dispatched to ${agent.name}`,
        now,
      ],
    );

    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        'task_completed',
        agent.id,
        task.id,
        `${agent.name} completed: ${completionSummary}`,
        now,
      ],
    );

    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        task.id,
        agent.id,
        'completed',
        `Agent reported completion: ${completionSummary}`,
        now,
      ],
    );

    return {
      status: 200,
      body: {
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        completed: true,
        new_status: 'testing',
        summary: completionSummary,
        message: 'Task dispatched and completed by agent',
      },
    };
  }

  run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['in_progress', now, taskId]);

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({
      type: 'task_updated',
      payload: updatedTask,
    });
  }

  run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['working', now, agent.id]);

  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      'task_dispatched',
      agent.id,
      task.id,
      `Task "${task.title}" dispatched to ${agent.name}`,
      now,
    ],
  );

  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      task.id,
      agent.id,
      'status_changed',
      `Task dispatched to ${agent.name} - Agent is now working on this task`,
      now,
    ],
  );

  return {
    status: 200,
    body: buildDispatchSuccessPayload(context),
  };
}
