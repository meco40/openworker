import { NextRequest, NextResponse } from 'next/server';
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

// GET /api/tasks/[id] - Get a single task
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const task = getTaskById(id);
    return NextResponse.json(task);
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to fetch task:', error);
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}

// PATCH /api/tasks/[id] - Update a task
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = await parseJsonBody(request, UpdateTaskSchema);
    if (!parsed.ok) {
      return parsed.response;
    }

    const result = updateTask(id, parsed.data);
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
        headers: { 'Content-Type': 'application/json' },
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
}

// DELETE /api/tasks/[id] - Delete a task
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    deleteTask(id);

    // Broadcast deletion via SSE
    broadcast({
      type: 'task_deleted',
      payload: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to delete task:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
