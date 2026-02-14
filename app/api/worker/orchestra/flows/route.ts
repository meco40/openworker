import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';
import {
  isWorkerOrchestraBuilderWriteEnabled,
  isWorkerOrchestraEnabled,
} from '../../../../../src/server/worker/orchestraFlags';
import { getOrchestraService } from '../../../../../src/server/worker/orchestraService';
import {
  canEditOrchestra,
  enforceOrchestraGraphLimits,
  normalizeWorkerRole,
} from '../../../../../src/server/worker/orchestraPolicy';
import type { WorkspaceType } from '../../../../../src/server/worker/workspaceManager';
import type { OrchestraFlowGraph } from '../../../../../src/server/worker/orchestraGraph';

export const runtime = 'nodejs';

const ALLOWED_WORKSPACE_TYPES = new Set<WorkspaceType>(['research', 'webapp', 'data', 'general']);

function normalizeWorkspaceType(value: unknown): WorkspaceType {
  if (typeof value !== 'string') return 'general';
  const normalized = value.trim().toLowerCase();
  return ALLOWED_WORKSPACE_TYPES.has(normalized as WorkspaceType)
    ? (normalized as WorkspaceType)
    : 'general';
}

function parseWorkspaceTypeFilter(value: unknown): WorkspaceType | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
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

export async function GET(request: Request) {
  try {
    if (!isWorkerOrchestraEnabled()) {
      return NextResponse.json({ ok: false, error: 'Orchestra disabled' }, { status: 404 });
    }

    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const workspaceType = parseWorkspaceTypeFilter(url.searchParams.get('workspaceType'));
    const repo = getWorkerRepository();
    const drafts = repo.listFlowDrafts(userContext.userId, workspaceType);
    const published = repo.listPublishedFlows(userContext.userId, workspaceType);

    return NextResponse.json({ ok: true, drafts, published });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to list flows';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
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

    const body = (await request.json()) as {
      name?: string;
      graph?: unknown;
      workspaceType?: string;
      templateId?: string | null;
    };

    if (!body.name || body.name.trim().length === 0) {
      return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    }

    let graph: Record<string, unknown>;
    try {
      graph = normalizeGraph(body.graph);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid graph';
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    const orchestraService = getOrchestraService();
    const typedGraph = graph as unknown as OrchestraFlowGraph;
    const graphNodes = Array.isArray(typedGraph.nodes) ? typedGraph.nodes : [];

    // Drafts allow empty graphs — full validation only enforced at publish time
    let finalGraph = typedGraph;
    if (graphNodes.length > 0) {
      const validation = orchestraService.validateGraphForUser(userContext.userId, graph);
      if (!validation.ok) {
        return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
      }
      const limitCheck = enforceOrchestraGraphLimits(validation.graph);
      if (!limitCheck.ok) {
        return NextResponse.json({ ok: false, error: limitCheck.error }, { status: 400 });
      }
      finalGraph = validation.graph;
    }

    const flow = orchestraService.createDraft({
      userId: userContext.userId,
      workspaceType: normalizeWorkspaceType(body.workspaceType),
      name: body.name.trim(),
      graph: finalGraph,
      templateId: body.templateId ?? null,
    });

    return NextResponse.json({ ok: true, flow }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
