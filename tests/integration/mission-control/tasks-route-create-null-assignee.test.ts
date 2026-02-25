import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('POST /api/tasks create validation', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tasks-route-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
  });

  afterEach(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('accepts null assigned_agent_id for inbox tasks', async () => {
    const { run } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = '8eb8edfd-8dca-4f01-b653-1a00745670c8';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Test Workspace', 'test-workspace', null, '📁', now, now],
    );

    const { POST } = await import('../../../app/api/tasks/route');
    const request = new NextRequest('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Test',
        description: 'Was ist die beste Agent Framework',
        priority: 'normal',
        status: 'inbox',
        assigned_agent_id: null,
        due_date: null,
        workspace_id: workspaceId,
      }),
    });

    const response = await POST(request);
    const payload = (await response.json()) as {
      id?: string;
      assigned_agent_id?: string | null;
      error?: string;
      details?: unknown;
    };

    expect(response.status).toBe(201);
    expect(typeof payload.id).toBe('string');
    expect(payload.assigned_agent_id).toBeNull();
  });
});
