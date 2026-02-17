/**
 * GET  /api/worker       → List all worker tasks (with optional status filter)
 * POST /api/worker       → Create a new worker task from WebUI
 */

import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../src/server/worker/workerRepository';
import { processQueue } from '../../../src/server/worker/workerAgent';
import { getWorkspaceManager } from '../../../src/server/worker/workspaceManager';
import { getMessageRepository } from '../../../src/server/channels/messages/runtime';
import type { WorkerTaskStatus } from '../../../src/server/worker/workerTypes';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const status = url.searchParams.get('status') as WorkerTaskStatus | null;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const repo = getWorkerRepository();
    const tasks = repo.listTasksForUser(userContext.userId, { status: status || undefined, limit });

    return NextResponse.json({ ok: true, tasks });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list tasks';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const repo = getWorkerRepository();
    const wsMgr = getWorkspaceManager();
    const tasks = repo.listTasksForUser(userContext.userId);

    let deleted = 0;
    for (const task of tasks) {
      try {
        wsMgr.deleteWorkspace(
          task.id,
          task.workspacePath ? { workspacePath: task.workspacePath } : undefined,
        );
      } catch {
        /* workspace may not exist */
      }
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
  conversationId?: string;
  workspaceType?: string;
  priority?: string;
  usePlanning?: boolean;
  flowPublishedId?: string;
  personaId?: string | null;
}

export async function POST(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await request.json()) as CreateTaskRequest;

    if (!body.objective) {
      return NextResponse.json({ ok: false, error: 'objective is required' }, { status: 400 });
    }

    const messageRepo = getMessageRepository();
    let originConversation = body.conversationId?.trim() || '';
    if (originConversation.length > 0) {
      const conversation = messageRepo.getConversation(originConversation, userContext.userId);
      if (!conversation) {
        originConversation = '';
      }
    }
    if (originConversation.length === 0) {
      originConversation = messageRepo.getDefaultWebChatConversation(userContext.userId).id;
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
      originConversation,
      usePlanning: body.usePlanning,
      userId: userContext.userId,
      flowPublishedId: body.flowPublishedId || null,
    });

    // Assign persona if selected
    if (body.personaId) {
      repo.assignPersona(task.id, body.personaId);

      // Get persona name for activity log
      let personaName = body.personaId;
      try {
        const { getPersonaRepository } =
          await import('../../../src/server/personas/personaRepository');
        const personaRepo = getPersonaRepository();
        const persona = personaRepo.getPersona(body.personaId);
        if (persona) {
          personaName = `${persona.emoji} ${persona.name}`;
        }
      } catch {
        // Persona not found, use ID as fallback
      }

      repo.addActivity({
        taskId: task.id,
        type: 'persona_assigned',
        message: `Persona ${personaName} zugewiesen`,
        metadata: { personaId: body.personaId, personaName },
      });
    }

    // Start queue processor (non-blocking) — skip for planning mode (task starts in inbox)
    if (!body.usePlanning) {
      processQueue().catch((err: unknown) => console.error('[API Worker] Queue error:', err));
    }

    // Return updated task with persona
    const updatedTask = repo.getTask(task.id);
    return NextResponse.json({ ok: true, task: updatedTask || task });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create task';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
