import { NextRequest, NextResponse } from 'next/server';
import { broadcast } from '@/lib/events';
import { CreateTaskSchema } from '@/lib/validation';
import { parseJsonBody } from '../_shared/parseJsonBody';
import { createTask, listTasks } from '@/server/tasks/taskService';

// GET /api/tasks - List all tasks with optional filters
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const tasks = listTasks({
      status: searchParams.get('status'),
      businessId: searchParams.get('business_id'),
      workspaceId: searchParams.get('workspace_id'),
      assignedAgentId: searchParams.get('assigned_agent_id'),
    });
    return NextResponse.json(tasks);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  try {
    const parsed = await parseJsonBody(request, CreateTaskSchema);
    if (!parsed.ok) {
      return parsed.response;
    }

    const created = createTask(parsed.data);

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
}
