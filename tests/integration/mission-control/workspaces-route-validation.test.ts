import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('workspaces route validation', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousRequireAuth: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousRequireAuth = process.env.REQUIRE_AUTH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-workspaces-route-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    process.env.REQUIRE_AUTH = 'false';
  });

  afterEach(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();

    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH;
    } else {
      process.env.REQUIRE_AUTH = previousRequireAuth;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('rejects invalid icon type on POST', async () => {
    const { POST } = await import('../../../app/api/workspaces/route');
    const request = new NextRequest('http://localhost/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Workspace A',
        icon: 42,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('rejects invalid name type on PATCH', async () => {
    const { run } = await import('@/lib/db');
    const workspaceId = crypto.randomUUID();
    const now = new Date().toISOString();
    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace A', 'workspace-a', null, '📁', now, now],
    );

    const { PATCH } = await import('../../../app/api/workspaces/[id]/route');
    const request = new NextRequest(`http://localhost/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 123,
      }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: workspaceId }) });
    expect(response.status).toBe(400);
  });
});
