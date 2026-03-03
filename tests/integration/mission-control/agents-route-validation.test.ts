import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('agents route validation', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousRequireAuth: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousRequireAuth = process.env.REQUIRE_AUTH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agents-route-'));
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

  it('rejects invalid is_master type on POST', async () => {
    const { POST } = await import('../../../app/api/agents/route');
    const request = new NextRequest('http://localhost/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Planner',
        role: 'Planner',
        is_master: 'yes',
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('rejects invalid status value on PATCH', async () => {
    const { run } = await import('@/lib/db');
    const agentId = crypto.randomUUID();
    const now = new Date().toISOString();

    run(
      `INSERT INTO agents (
        id, name, role, description, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Agent A', 'Builder', null, '🤖', 'standby', 0, 'default', 'local', now, now],
    );

    const { PATCH } = await import('../../../app/api/agents/[id]/route');
    const request = new NextRequest(`http://localhost/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'invalid-status',
      }),
    });

    const response = await PATCH(request, { params: Promise.resolve({ id: agentId }) });
    expect(response.status).toBe(400);
  });
});
