// ─── Workspace Files API ────────────────────────────────────
// GET  /api/worker/:id/files         → List workspace files
// GET  /api/worker/:id/files?path=.. → Read file content
// POST /api/worker/:id/files         → Write file to workspace

import { NextRequest, NextResponse } from 'next/server';
import { SqliteWorkerRepository } from '@/server/worker/workerRepository';
import { getWorkspaceManager } from '@/server/worker/workspaceManager';
import path from 'node:path';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const repo = new SqliteWorkerRepository();
  const task = repo.getTask(id);

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const mgr = getWorkspaceManager();
  if (!mgr.exists(id)) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  const filePath = url.searchParams.get('path');

  // If path param → read specific file
  if (filePath) {
    // Security: prevent path traversal
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    const content = mgr.readFile(id, normalized);
    if (!content) {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Detect if binary or text
    const ext = path.extname(normalized).toLowerCase();
    const textExts = [
      '.txt',
      '.md',
      '.json',
      '.html',
      '.css',
      '.js',
      '.ts',
      '.tsx',
      '.jsx',
      '.log',
      '.csv',
      '.xml',
      '.yml',
      '.yaml',
      '.toml',
      '.env',
      '.sh',
      '.bat',
      '.ps1',
      '.py',
      '.rb',
      '.go',
      '.rs',
      '.java',
      '.c',
      '.cpp',
      '.h',
      '.sql',
    ];

    if (textExts.includes(ext)) {
      return NextResponse.json({
        path: normalized,
        type: 'text',
        content: content.toString('utf-8'),
        size: content.length,
      });
    } else {
      return NextResponse.json({
        path: normalized,
        type: 'binary',
        content: content.toString('base64'),
        mimeType: getMimeType(ext),
        size: content.length,
      });
    }
  }

  // No path → list all files
  const files = mgr.listFiles(id);
  return NextResponse.json({
    taskId: id,
    workspaceType: task.workspaceType,
    files,
    totalSize: mgr.getWorkspaceSize(id),
  });
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const repo = new SqliteWorkerRepository();
  const task = repo.getTask(id);

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const mgr = getWorkspaceManager();
  if (!mgr.exists(id)) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  const body = await request.json();
  const {
    path: filePath,
    content,
    encoding,
  } = body as {
    path: string;
    content: string;
    encoding?: 'utf-8' | 'base64';
  };

  if (!filePath || content === undefined) {
    return NextResponse.json({ error: 'path and content required' }, { status: 400 });
  }

  // Security: prevent path traversal
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  if (encoding === 'base64') {
    mgr.writeFile(id, normalized, Buffer.from(content, 'base64'));
  } else {
    mgr.writeFile(id, normalized, content);
  }

  return NextResponse.json({ ok: true, path: normalized });
}

// ─── Helpers ─────────────────────────────────────────────────

function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return mimeMap[ext] || 'application/octet-stream';
}
