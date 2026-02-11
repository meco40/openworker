// ─── Workspace Export API ────────────────────────────────────
// GET /api/worker/:id/export → Download workspace as ZIP

import { NextResponse } from 'next/server';
import { getWorkerRepository } from '@/server/worker/workerRepository';
import { getWorkspaceManager } from '@/server/worker/workspaceManager';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const repo = getWorkerRepository();
    const task = repo.getTask(id);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const mgr = getWorkspaceManager();
    if (!mgr.exists(id)) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const wsPath = mgr.getWorkspacePath(id);
    const zipName = `workspace-${task.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}-${id.slice(0, 8)}.zip`;

    // Create archive stream
    const archive = archiver('zip', { zlib: { level: 6 } });
    const passthrough = new PassThrough();

    // Pipe archive to passthrough
    archive.pipe(passthrough);
    archive.directory(wsPath, false);
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
