/**
 * GET  /api/worker       → List all worker tasks (with optional status filter)
 * POST /api/worker       → Create a new worker task from WebUI
 */

import { NextResponse } from 'next/server';
import { getWorkerRepository } from '../../../src/server/worker/workerRepository';
import { processQueue } from '../../../src/server/worker/workerAgent';
import { getWorkspaceManager } from '../../../src/server/worker/workspaceManager';
import type { WorkerTaskStatus } from '../../../src/server/worker/workerTypes';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as WorkerTaskStatus | null;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const repo = getWorkerRepository();
    const tasks = repo.listTasks({ status: status || undefined, limit });

    return NextResponse.json({ ok: true, tasks });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list tasks';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const repo = getWorkerRepository();
    const wsMgr = getWorkspaceManager();
    const tasks = repo.listTasks();

    let deleted = 0;
    for (const task of tasks) {
      try {
        wsMgr.deleteWorkspace(task.id);
      } catch { /* workspace may not exist */ }
      repo.deleteTask(task.id);
      deleted++;
    }

    return NextResponse.json({ ok: true, message: `${deleted} tasks deleted`, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete all tasks';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

interface CreateTaskRequest {
  objective: string;
  title?: string;
  conversationId: string;
  workspaceType?: string;
  priority?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateTaskRequest;

    if (!body.objective || !body.conversationId) {
      return NextResponse.json(
        { ok: false, error: 'objective and conversationId are required' },
        { status: 400 },
      );
    }

    const repo = getWorkerRepository();
    const task = repo.createTask({
      title: body.title || body.objective.slice(0, 60),
      objective: body.objective,
      priority: (body.priority as 'low' | 'normal' | 'high' | 'urgent') || 'normal',
      workspaceType:
        (body.workspaceType as 'research' | 'webapp' | 'creative' | 'data' | 'general') ||
        undefined,
      originPlatform: 'WebChat' as never,
      originConversation: body.conversationId,
    });

    // Start queue processor (non-blocking)
    processQueue().catch((err: unknown) => console.error('[API Worker] Queue error:', err));

    return NextResponse.json({ ok: true, task });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create task';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
