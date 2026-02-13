/**
 * GET    /api/worker/:id  → Get task details with steps + artifacts
 * PATCH  /api/worker/:id  → Update task: cancel, resume, approve, deny
 * DELETE /api/worker/:id  → Delete task + workspace\r\n */

import { NextResponse } from 'next/server';
import { getWorkerRepository } from '../../../../src/server/worker/workerRepository';
import { processQueue } from '../../../../src/server/worker/workerAgent';
import { getWorkspaceManager } from '../../../../src/server/worker/workspaceManager';
import { canTransition } from '../../../../src/server/worker/workerStateMachine';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const repo = getWorkerRepository();

    const task = repo.getTask(id);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    const steps = repo.getSteps(id);
    const artifacts = repo.getArtifacts(id);

    return NextResponse.json({ ok: true, task, steps, artifacts });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to get task';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

interface PatchRequest {
  action: 'cancel' | 'resume' | 'retry' | 'approve' | 'deny' | 'approve-always' | 'move' | 'assign';
  status?: string;
  personaId?: string | null;
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = (await request.json()) as PatchRequest;
    const repo = getWorkerRepository();

    const task = repo.getTask(id);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    switch (body.action) {
      case 'cancel':
        repo.cancelTask(id);
        return NextResponse.json({ ok: true, message: 'Task cancelled' });

      case 'resume': {
        if (task.status !== 'interrupted' && task.status !== 'failed') {
          return NextResponse.json(
            { ok: false, error: `Cannot resume task with status: ${task.status}` },
            { status: 400 },
          );
        }
        repo.updateStatus(id, 'queued');
        processQueue().catch((err: unknown) => console.error('[API Worker] Queue error:', err));
        return NextResponse.json({ ok: true, message: 'Task resumed' });
      }

      case 'retry': {
        if (task.status !== 'failed') {
          return NextResponse.json(
            { ok: false, error: `Cannot retry task with status: ${task.status}` },
            { status: 400 },
          );
        }
        repo.updateStatus(id, 'queued');
        processQueue().catch((err: unknown) => console.error('[API Worker] Queue error:', err));
        return NextResponse.json({ ok: true, message: 'Task retrying' });
      }

      case 'approve': {
        if (task.status !== 'waiting_approval') {
          return NextResponse.json(
            { ok: false, error: 'Task is not waiting for approval' },
            { status: 400 },
          );
        }
        repo.saveCheckpoint(id, { approvalResponse: 'approved' });
        return NextResponse.json({ ok: true, message: 'Approved' });
      }

      case 'deny': {
        if (task.status !== 'waiting_approval') {
          return NextResponse.json(
            { ok: false, error: 'Task is not waiting for approval' },
            { status: 400 },
          );
        }
        repo.saveCheckpoint(id, { approvalResponse: 'denied' });
        return NextResponse.json({ ok: true, message: 'Denied' });
      }

      case 'approve-always': {
        if (task.status !== 'waiting_approval') {
          return NextResponse.json(
            { ok: false, error: 'Task is not waiting for approval' },
            { status: 400 },
          );
        }
        const checkpoint = task.lastCheckpoint ? JSON.parse(task.lastCheckpoint) : {};
        if (checkpoint.pendingCommand) {
          repo.addApprovalRule(checkpoint.pendingCommand);
        }
        repo.saveCheckpoint(id, { approvalResponse: 'approved' });
        return NextResponse.json({ ok: true, message: 'Approved and saved for future' });
      }

      case 'move': {
        const targetStatus = body.status;
        if (!targetStatus) {
          return NextResponse.json({ ok: false, error: 'Missing target status' }, { status: 400 });
        }
        if (
          !canTransition(
            task.status as Parameters<typeof canTransition>[0],
            targetStatus as Parameters<typeof canTransition>[1],
            'manual',
          )
        ) {
          return NextResponse.json(
            {
              ok: false,
              error: `Transition ${task.status} → ${targetStatus} nicht erlaubt`,
            },
            { status: 409 },
          );
        }
        repo.updateStatus(id, targetStatus as Parameters<typeof repo.updateStatus>[1]);
        // Trigger processQueue when task moves to queued
        if (targetStatus === 'queued') {
          processQueue().catch((err: unknown) => console.error('[API Worker] Queue error:', err));
        }
        return NextResponse.json({ ok: true, task: repo.getTask(id) });
      }

      case 'assign': {
        const personaId = body.personaId ?? null;
        repo.assignPersona(id, personaId);
        if (personaId) {
          repo.addActivity({
            taskId: id,
            type: 'persona_assigned',
            message: `Persona ${personaId} zugewiesen`,
            metadata: { personaId },
          });
        }
        return NextResponse.json({ ok: true, task: repo.getTask(id) });
      }

      default:
        return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update task';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTask(id);

    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    // Delete workspace folder if it exists
    const wsMgr = getWorkspaceManager();
    wsMgr.deleteWorkspace(id);

    // Delete from database
    repo.deleteTask(id);

    return NextResponse.json({ ok: true, message: `Task ${id} and workspace deleted` });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete task';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
