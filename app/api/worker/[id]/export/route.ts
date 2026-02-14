// ─── Workspace Export API ────────────────────────────────────
// GET /api/worker/:id/export → Download workspace as ZIP

import { NextResponse } from 'next/server';
import { resolveRequestUserContext } from '../../../../../src/server/auth/userContext';
import { getWorkerRepository } from '../../../../../src/server/worker/workerRepository';
import { getWorkspaceManager } from '../../../../../src/server/worker/workspaceManager';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const userContext = await resolveRequestUserContext();
    if (!userContext) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTaskForUser(id, userContext.userId);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const mgr = getWorkspaceManager();
    if (!mgr.exists(id)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const deliverables = repo.listDeliverables(id).map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      mimeType: item.mimeType,
      source: 'deliverable',
      createdAt: item.createdAt,
      content: item.content,
    }));
    const legacyArtifacts = repo.getArtifacts(id).map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      mimeType: artifact.mimeType,
      source: 'legacy-artifact',
      createdAt: artifact.createdAt,
      content: artifact.content,
    }));
    const mergedDeliverables = [...deliverables, ...legacyArtifacts].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );

    const manifest = {
      taskId: task.id,
      taskTitle: task.title,
      generatedAt: new Date().toISOString(),
      deliverableCount: mergedDeliverables.length,
      deliverables: mergedDeliverables.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        mimeType: item.mimeType,
        source: item.source,
        createdAt: item.createdAt,
      })),
    };

    const wsPath = mgr.getWorkspacePath(id);
    const zipName = `workspace-${task.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}-${id.slice(0, 8)}.zip`;

    // Create archive stream
    const archive = archiver('zip', { zlib: { level: 6 } });
    const passthrough = new PassThrough();

    // Pipe archive to passthrough
    archive.pipe(passthrough);
    archive.directory(wsPath, 'workspace');
    archive.append(JSON.stringify(manifest, null, 2), { name: 'deliverables.json' });
    for (const item of mergedDeliverables) {
      const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      archive.append(item.content, {
        name: `deliverables/${safeName}`,
      });
    }
    archive.finalize();

    // Collect chunks into a Buffer (needed for NextResponse)
    const chunks: Buffer[] = [];
    for await (const chunk of passthrough) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const zipBuffer = Buffer.concat(chunks);

    return new Response(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
        'Content-Length': String(zipBuffer.length),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to export workspace';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
