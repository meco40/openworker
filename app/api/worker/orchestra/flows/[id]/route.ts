import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../../src/server/worker/workerRepository';
import { getOrchestraService } from '../../../../../../src/server/worker/orchestraService';
import type { WorkspaceType } from '../../../../../../src/server/worker/workspaceManager';

export const runtime = 'nodejs';

const ALLOWED_WORKSPACE_TYPES = new Set<WorkspaceType>(['research', 'webapp', 'data', 'general']);

function normalizeWorkspaceType(value: unknown): WorkspaceType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_WORKSPACE_TYPES.has(normalized as WorkspaceType)) return undefined;
  return normalized as WorkspaceType;
}

function normalizeGraph(graph: unknown): Record<string, unknown> {
  if (!graph || typeof graph !== 'object') {
    throw new Error('graph is required');
  }
  return graph as Record<string, unknown>;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getWorkerRepository();
    const flow = repo.getFlowDraft(id, userContext.userId);
    if (!flow) {
      return NextResponse.json({ ok: false, error: 'Flow not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, flow });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const body = (await request.json()) as {
      name?: string;
      graph?: unknown;
      workspaceType?: string;
    };

    const updates: { name?: string; graph?: Record<string, unknown>; workspaceType?: WorkspaceType } = {};
    if (typeof body.name === 'string') {
      const trimmed = body.name.trim();
      if (trimmed.length === 0) {
        return NextResponse.json({ ok: false, error: 'name cannot be empty' }, { status: 400 });
      }
      updates.name = trimmed;
    }
    if (body.graph !== undefined) {
      try {
        updates.graph = normalizeGraph(body.graph);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid graph';
        return NextResponse.json({ ok: false, error: message }, { status: 400 });
      }
    }
    const normalizedWorkspace = normalizeWorkspaceType(body.workspaceType);
    if (body.workspaceType !== undefined && !normalizedWorkspace) {
      return NextResponse.json({ ok: false, error: 'invalid workspace type' }, { status: 400 });
    }
    if (normalizedWorkspace) {
      updates.workspaceType = normalizedWorkspace;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ ok: false, error: 'No updates provided' }, { status: 400 });
    }

    const orchestraService = getOrchestraService();
    if (updates.graph) {
      const validation = orchestraService.validateGraphForUser(userContext.userId, updates.graph);
      if (!validation.ok) {
        return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
      }
      updates.graph = validation.graph;
    }

    const flow = orchestraService.updateDraft(id, userContext.userId, updates);
    if (!flow) {
      return NextResponse.json({ ok: false, error: 'Flow not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, flow });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
