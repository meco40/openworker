import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';
import type { WorkspaceType } from '../../../../../src/server/worker/workspaceManager';

export const runtime = 'nodejs';

const ALLOWED_WORKSPACE_TYPES = new Set<WorkspaceType>(['research', 'webapp', 'data', 'general']);

function normalizeWorkspaceType(value: unknown): WorkspaceType {
  if (typeof value !== 'string') return 'general';
  const normalized = value.trim().toLowerCase();
  return ALLOWED_WORKSPACE_TYPES.has(normalized as WorkspaceType)
    ? (normalized as WorkspaceType)
    : 'general';
}

function normalizeGraphJson(graph: unknown): string {
  if (!graph || typeof graph !== 'object') {
    throw new Error('graph is required');
  }
  return JSON.stringify(graph);
}

export async function GET(request: Request) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const workspaceType = normalizeWorkspaceType(url.searchParams.get('workspaceType'));
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
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
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

    let graphJson: string;
    try {
      graphJson = normalizeGraphJson(body.graph);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid graph';
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }

    const repo = getWorkerRepository();
    const flow = repo.createFlowDraft({
      userId: userContext.userId,
      workspaceType: normalizeWorkspaceType(body.workspaceType),
      name: body.name.trim(),
      graphJson,
      templateId: body.templateId ?? null,
    });

    return NextResponse.json({ ok: true, flow }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create flow';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
