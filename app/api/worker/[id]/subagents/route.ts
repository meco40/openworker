import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';

export const runtime = 'nodejs';

const ALLOWED_SUBAGENT_STATUSES = new Set([
  'started',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTaskForUser(id, userContext.userId);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    const sessions = repo.listSubagentSessions(id);
    return NextResponse.json({ ok: true, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to list subagent sessions';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTaskForUser(id, userContext.userId);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    const body = (await request.json()) as {
      runId?: string | null;
      nodeId?: string | null;
      personaId?: string | null;
      sessionRef?: string | null;
      metadata?: Record<string, unknown>;
    };

    const session = repo.createSubagentSession({
      taskId: id,
      userId: userContext.userId,
      runId: body.runId || null,
      nodeId: body.nodeId || null,
      personaId: body.personaId || null,
      sessionRef: body.sessionRef || null,
      metadata: body.metadata,
    });

    return NextResponse.json({ ok: true, session }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create subagent session';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTaskForUser(id, userContext.userId);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'Task not found' }, { status: 404 });
    }

    const body = (await request.json()) as {
      sessionId?: string;
      status?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.sessionId || body.sessionId.trim().length === 0) {
      return NextResponse.json({ ok: false, error: 'sessionId is required' }, { status: 400 });
    }
    if (body.status && !ALLOWED_SUBAGENT_STATUSES.has(body.status)) {
      return NextResponse.json({ ok: false, error: 'invalid status' }, { status: 400 });
    }

    const session = repo.updateSubagentSession(id, body.sessionId.trim(), {
      status: body.status as Parameters<typeof repo.updateSubagentSession>[2]['status'],
      metadata: body.metadata,
    });
    if (!session) {
      return NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update subagent session';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
