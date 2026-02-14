import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';

export const runtime = 'nodejs';

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

    const deliverables = repo
      .listDeliverables(id)
      .map((item) => ({ ...item, source: 'deliverable' as const }));
    const legacyArtifacts = repo.getArtifacts(id).map((artifact) => ({
      id: `legacy-${artifact.id}`,
      taskId: artifact.taskId,
      runId: null,
      nodeId: null,
      type: 'artifact' as const,
      name: artifact.name,
      content: artifact.content,
      mimeType: artifact.mimeType,
      metadata: JSON.stringify({ legacyArtifactId: artifact.id, artifactType: artifact.type }),
      createdAt: artifact.createdAt,
      source: 'legacy-artifact' as const,
    }));

    return NextResponse.json({
      ok: true,
      deliverables: [...deliverables, ...legacyArtifacts].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to list deliverables';
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
      type?: 'file' | 'url' | 'artifact' | 'text';
      name?: string;
      content?: string;
      mimeType?: string | null;
      metadata?: Record<string, unknown>;
    };

    if (!body.name || body.name.trim().length === 0) {
      return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    }
    if (typeof body.content !== 'string') {
      return NextResponse.json({ ok: false, error: 'content is required' }, { status: 400 });
    }

    const deliverable = repo.addDeliverable({
      taskId: id,
      runId: body.runId || null,
      nodeId: body.nodeId || null,
      type: body.type || 'file',
      name: body.name.trim(),
      content: body.content,
      mimeType: body.mimeType || null,
      metadata: body.metadata,
    });

    return NextResponse.json({ ok: true, deliverable }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create deliverable';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
