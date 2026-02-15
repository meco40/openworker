import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../../src/server/worker/workerRepository';
import {
  isWorkerOrchestraBuilderWriteEnabled,
  isWorkerOrchestraEnabled,
} from '../../../../../../src/server/worker/orchestraFlags';
import { getOrchestraService } from '../../../../../../src/server/worker/orchestraService';
import {
  canEditOrchestra,
  enforceOrchestraGraphLimits,
  normalizeWorkerRole,
} from '../../../../../../src/server/worker/orchestraPolicy';
import type { OrchestraFlowGraph } from '../../../../../../src/server/worker/orchestraGraph';
import type { WorkspaceType } from '../../../../../../src/server/worker/workspaceManager';

export const runtime = 'nodejs';

const ALLOWED_WORKSPACE_TYPES = new Set<WorkspaceType>(['research', 'webapp', 'data', 'general']);

function normalizeWorkspaceType(value: unknown): WorkspaceType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_WORKSPACE_TYPES.has(normalized as WorkspaceType)) return undefined;
  return normalized as WorkspaceType;
}

function normalizeGraph(graph: unknown): OrchestraFlowGraph {
  if (!graph || typeof graph !== 'object') {
    throw new Error('graph is required');
  }
  return graph as OrchestraFlowGraph;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isWorkerOrchestraEnabled()) {
      return NextResponse.json({ ok: false, error: 'Orchestra disabled' }, { status: 404 });
    }

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

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isWorkerOrchestraEnabled()) {
      return NextResponse.json({ ok: false, error: 'Orchestra disabled' }, { status: 404 });
    }
    if (!isWorkerOrchestraBuilderWriteEnabled()) {
      return NextResponse.json(
        { ok: false, error: 'Orchestra builder write disabled' },
        { status: 403 },
      );
    }

    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const workerRole = normalizeWorkerRole(request.headers.get('x-worker-role'));
    if (!canEditOrchestra(workerRole)) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;
    const body = (await request.json()) as {
      name?: string;
      graph?: unknown;
      workspaceType?: string;
      expectedUpdatedAt?: string;
    };

    const updates: { name?: string; graph?: OrchestraFlowGraph; workspaceType?: WorkspaceType } =
      {};
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
      const graphNodes = Array.isArray(updates.graph.nodes) ? updates.graph.nodes : [];
      // Drafts allow incomplete graphs — full validation only enforced at publish time
      if (graphNodes.length > 0) {
        const validation = orchestraService.validateGraphForUser(userContext.userId, updates.graph);
        if (!validation.ok) {
          return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
        }
        const limitCheck = enforceOrchestraGraphLimits(validation.graph);
        if (!limitCheck.ok) {
          return NextResponse.json({ ok: false, error: limitCheck.error }, { status: 400 });
        }
        updates.graph = validation.graph;
      }
    }

    const flow = orchestraService.updateDraft(
      id,
      userContext.userId,
      updates,
      body.expectedUpdatedAt,
    );
    if (!flow) {
      // Could be not found OR optimistic locking conflict
      const existing = getWorkerRepository().getFlowDraft(id, userContext.userId);
      if (existing && body.expectedUpdatedAt && existing.updatedAt !== body.expectedUpdatedAt) {
        return NextResponse.json(
          { ok: false, error: 'Draft wurde in einem anderen Tab geändert. Bitte neu laden.' },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: false, error: 'Flow not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, flow });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isWorkerOrchestraEnabled()) {
      return NextResponse.json({ ok: false, error: 'Orchestra disabled' }, { status: 404 });
    }
    if (!isWorkerOrchestraBuilderWriteEnabled()) {
      return NextResponse.json(
        { ok: false, error: 'Orchestra builder write disabled' },
        { status: 403 },
      );
    }

    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getWorkerRepository();

    // Try draft first, then published
    const draft = repo.getFlowDraft(id, userContext.userId);
    if (draft) {
      const deleted = repo.deleteFlowDraft(id, userContext.userId);
      if (!deleted) {
        return NextResponse.json(
          { ok: false, error: 'Konnte Draft nicht löschen' },
          { status: 400 },
        );
      }
      return NextResponse.json({ ok: true, deleted: 'draft' });
    }

    const pub = repo.getFlowPublished(id, userContext.userId);
    if (pub) {
      const deleted = repo.deletePublishedFlow(id, userContext.userId);
      if (!deleted) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Flow wird von einem Task referenziert und kann nicht gelöscht werden.',
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true, deleted: 'published' });
    }

    return NextResponse.json({ ok: false, error: 'Flow not found' }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to delete flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
