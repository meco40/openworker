import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control task route response shape', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tasks-agent-shape-'));
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
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows sqlite handle contention in test teardown.
      }
      tempDir = '';
    }
  });

  it('returns assigned_agent object in POST /api/tasks response', async () => {
    const { run } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-1';
    const agentId = '5d3e3f44-df21-411e-98ef-a9a2e96ded89';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Planner One', 'Planner', '🧠', 'standby', 0, workspaceId, 'local', now, now],
    );

    const { POST } = await import('../../../app/api/tasks/route');
    const request = new NextRequest('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Assigned task',
        status: 'assigned',
        priority: 'normal',
        assigned_agent_id: agentId,
        workspace_id: workspaceId,
      }),
    });

    const response = await POST(request);
    const payload = (await response.json()) as {
      assigned_agent?: { id?: string; name?: string; avatar_emoji?: string };
    };

    expect(response.status).toBe(201);
    expect(payload.assigned_agent).toEqual({
      id: agentId,
      name: 'Planner One',
      avatar_emoji: '🧠',
    });
  });

  it('returns assigned_agent object in PATCH /api/tasks/[id] response', async () => {
    const { run } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-2';
    const taskId = 'task-2';
    const agentId = '2c0ec18e-49fb-494d-880d-64dd4ca8c1e3';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-2', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Executor One', 'Executor', '⚡', 'standby', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Patch me',
        null,
        'assigned',
        'normal',
        agentId,
        null,
        workspaceId,
        'default',
        null,
        now,
        now,
      ],
    );

    const route = await import('../../../app/api/tasks/[id]/route');
    const request = new NextRequest(`http://localhost/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Patched title' }),
    });

    const response = await route.PATCH(request, { params: Promise.resolve({ id: taskId }) });
    const payload = (await response.json()) as {
      assigned_agent?: { id?: string; name?: string; avatar_emoji?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.assigned_agent).toEqual({
      id: agentId,
      name: 'Executor One',
      avatar_emoji: '⚡',
    });
  });

  it('returns assigned_agent object in GET /api/tasks/[id] response', async () => {
    const { run } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-3';
    const taskId = 'task-3';
    const agentId = '2f6f95dd-0347-4f70-b22d-7a2f9f85739a';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-3', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Reviewer One', 'Reviewer', '🔍', 'standby', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Get me',
        null,
        'review',
        'normal',
        agentId,
        null,
        workspaceId,
        'default',
        null,
        now,
        now,
      ],
    );

    const route = await import('../../../app/api/tasks/[id]/route');
    const request = new NextRequest(`http://localhost/api/tasks/${taskId}`, {
      method: 'GET',
    });

    const response = await route.GET(request, { params: Promise.resolve({ id: taskId }) });
    const payload = (await response.json()) as {
      assigned_agent?: { id?: string; name?: string; avatar_emoji?: string };
    };

    expect(response.status).toBe(200);
    expect(payload.assigned_agent).toEqual({
      id: agentId,
      name: 'Reviewer One',
      avatar_emoji: '🔍',
    });
  });
});
