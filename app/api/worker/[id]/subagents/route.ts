import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';
import { getPersonaRepository } from '../../../../../src/server/personas/personaRepository';

export const runtime = 'nodejs';

const ALLOWED_SUBAGENT_STATUSES = new Set([
  'started',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

function normalizeOptionalId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
      allowPersonaOverride?: boolean;
      sessionRef?: string | null;
      source?: 'legacy' | 'openai';
      metadata?: Record<string, unknown>;
    };

    const taskPersonaId = task.assignedPersonaId || null;
    const explicitPersonaRequested = body.personaId !== undefined;
    const requestedPersonaId = normalizeOptionalId(body.personaId);
    if (explicitPersonaRequested && requestedPersonaId === undefined) {
      return NextResponse.json(
        { ok: false, error: 'personaId must be a string or null' },
        { status: 400 },
      );
    }

    let resolvedPersonaId = taskPersonaId;
    let personaResolution: 'inherited_task_persona' | 'task_default_none' | 'explicit_override' =
      taskPersonaId ? 'inherited_task_persona' : 'task_default_none';

    if (explicitPersonaRequested && requestedPersonaId !== taskPersonaId) {
      if (!body.allowPersonaOverride) {
        return NextResponse.json(
          { ok: false, error: 'persona override requires allowPersonaOverride=true' },
          { status: 400 },
        );
      }
      resolvedPersonaId = requestedPersonaId ?? null;
      personaResolution = 'explicit_override';
    }

    let resolvedPersonaModelHubProfileId: string | null = null;
    let resolvedPersonaPreferredModelId: string | null = null;
    if (resolvedPersonaId) {
      const personaRepo = getPersonaRepository();
      const persona = personaRepo.getPersona(resolvedPersonaId);
      if (!persona || persona.userId !== userContext.userId) {
        return NextResponse.json({ ok: false, error: 'persona not found' }, { status: 400 });
      }
      resolvedPersonaModelHubProfileId =
        (persona as { modelHubProfileId?: string | null }).modelHubProfileId || null;
      resolvedPersonaPreferredModelId = persona.preferredModelId || null;
    }

    const session = repo.createSubagentSession({
      taskId: id,
      userId: userContext.userId,
      runId: body.runId || null,
      nodeId: body.nodeId || null,
      personaId: resolvedPersonaId,
      sessionRef: body.sessionRef || null,
      metadata: {
        ...(body.metadata || {}),
        source: body.source || 'legacy',
        personaResolution,
        taskPersonaId,
        requestedPersonaId: explicitPersonaRequested ? (requestedPersonaId ?? null) : null,
        resolvedPersonaId,
        modelHubProfileId: resolvedPersonaModelHubProfileId,
        preferredModelId: resolvedPersonaPreferredModelId,
      },
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
      source?: 'legacy' | 'openai';
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
      metadata: {
        ...(body.metadata || {}),
        ...(body.source ? { source: body.source } : {}),
      },
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
