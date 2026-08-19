import { NextResponse } from 'next/server';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import {
  ensureTaskDeliverablesFromProjectDir,
  triggerAutomatedTaskTest,
} from '@/server/tasks/autoTesting';
import { UpdateTaskSchema } from '@/lib/validation';
import { parseJsonBody } from '../../_shared/parseJsonBody';
import {
  deleteTask,
  getTaskById,
  TaskForbiddenError,
  TaskNoUpdatesError,
  TaskNotFoundError,
  updateTask,
} from '@/server/tasks/taskService';
import { withUserContext } from '../../_shared/withUserContext';
import {
  canAccessTask,
  getAgentWorkspaceId,
  getTaskWorkspaceId,
} from '@/server/auth/workspaceAccess';
import { getInternalRequestHeaders } from '@/server/auth/internalRequest';

// GET /api/tasks/[id] - Get a single task
export const GET = withUserContext<{ id: string }>(async ({ params, userContext }) => {
  try {
    const { id } = params;
    if (!canAccessTask(userContext, id)) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const task = getTaskById(id);
    return NextResponse.json(task);
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to fetch task:', error);
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
});

// PATCH /api/tasks/[id] - Update a task
export const PATCH = withUserContext<{ id: string }>(async ({ request, params, userContext }) => {
  try {
    const { id } = params;
    if (!canAccessTask(userContext, id)) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const parsed = await parseJsonBody(request, UpdateTaskSchema);
    if (!parsed.ok) {
      return parsed.response;
    }
    const workspaceId = getTaskWorkspaceId(id);
    for (const agentId of [parsed.data.assigned_agent_id, parsed.data.updated_by_agent_id]) {
      if (agentId && (!workspaceId || getAgentWorkspaceId(agentId) !== workspaceId)) {
        return NextResponse.json(
          { error: 'Referenced agent must belong to the task workspace' },
          { status: 400 },
        );
      }
    }

    const result = updateTask(id, { ...parsed.data, userId: userContext.userId });
    const hydratedTask = result.task;

    // Broadcast task update via SSE
    if (hydratedTask) {
      broadcast({
        type: 'task_updated',
        payload: hydratedTask,
      });
    }

    // Trigger auto-dispatch if needed
    if (result.shouldDispatch) {
      // Call dispatch endpoint asynchronously (don't wait for response)
      const missionControlUrl = getMissionControlUrl();
      fetch(`${missionControlUrl}/api/tasks/${id}/dispatch`, {
        method: 'POST',
        headers: getInternalRequestHeaders({ 'Content-Type': 'application/json' }),
      }).catch((err) => {
        console.error('Auto-dispatch failed:', err);
      });
    }

    if (result.shouldAutoTest) {
      ensureTaskDeliverablesFromProjectDir({
        taskId: id,
        taskTitle: hydratedTask?.title || parsed.data.title || result.previousTitle,
      });
      triggerAutomatedTaskTest(id);
    }

    return NextResponse.json(hydratedTask);
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof TaskNoUpdatesError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TaskForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('Failed to update task:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
});

// DELETE /api/tasks/[id] - Delete a task
export const DELETE = withUserContext<{ id: string }>(async ({ params, userContext }) => {
  try {
    const { id } = params;
    const workspaceId = getTaskWorkspaceId(id);
    if (!workspaceId || !canAccessTask(userContext, id)) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    deleteTask(id, userContext.userId);

    // Broadcast deletion via SSE
    broadcast({
      type: 'task_deleted',
      payload: { id, workspace_id: workspaceId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to delete task:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
});
