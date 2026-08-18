import { NextResponse } from 'next/server';
import { broadcast } from '@/lib/events';
import { CreateTaskSchema } from '@/lib/validation';
import { parseJsonBody } from '../_shared/parseJsonBody';
import { withUserContext } from '../_shared/withUserContext';
import { createTask, listTasks } from '@/server/tasks/taskService';
import {
  getAccessibleWorkspaceIds,
  getAgentWorkspaceId,
  hasWorkspaceAccess,
  normalizeWorkspaceId,
} from '@/server/auth/workspaceAccess';

// GET /api/tasks - List all tasks with optional filters
export const GET = withUserContext(async ({ request, userContext }) => {
  try {
    const { searchParams } = new URL(request.url);
    const requestedWorkspaceId = searchParams.get('workspace_id');
    if (requestedWorkspaceId && !hasWorkspaceAccess(userContext, requestedWorkspaceId)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    const tasks = listTasks({
      status: searchParams.get('status'),
      businessId: searchParams.get('business_id'),
      workspaceId: requestedWorkspaceId,
      workspaceIds: requestedWorkspaceId ? undefined : getAccessibleWorkspaceIds(userContext),
      assignedAgentId: searchParams.get('assigned_agent_id'),
    });
    return NextResponse.json(tasks);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
});

// POST /api/tasks - Create a new task
export const POST = withUserContext(async ({ request, userContext }) => {
  try {
    const parsed = await parseJsonBody(request, CreateTaskSchema);
    if (!parsed.ok) {
      return parsed.response;
    }

    const workspaceId = normalizeWorkspaceId(parsed.data.workspace_id || 'default');
    if (!workspaceId || !hasWorkspaceAccess(userContext, workspaceId)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    for (const agentId of [parsed.data.assigned_agent_id, parsed.data.created_by_agent_id]) {
      if (agentId && getAgentWorkspaceId(agentId) !== workspaceId) {
        return NextResponse.json(
          { error: 'Referenced agent must belong to the task workspace' },
          { status: 400 },
        );
      }
    }

    const created = createTask({ ...parsed.data, workspace_id: workspaceId });

    // Broadcast task creation via SSE
    if (created) {
      broadcast({
        type: 'task_created',
        payload: created,
      });
    }

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error('Failed to create task:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
});
