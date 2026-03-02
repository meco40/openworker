import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control task PATCH auto-testing trigger', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousProjectsPath: string | undefined;
  let previousPort: string | undefined;
  let previousAutoTestTrigger: string | undefined;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousProjectsPath = process.env.PROJECTS_PATH;
    previousPort = process.env.PORT;
    previousAutoTestTrigger = process.env.TASK_AUTOTEST_HTTP_TRIGGER;
    originalFetch = global.fetch;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tasks-auto-test-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    process.env.PROJECTS_PATH = path.join(tempDir, 'projects');
    process.env.PORT = '3000';
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';
  });

  afterEach(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();

    if (originalFetch) {
      global.fetch = originalFetch;
    }

    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousProjectsPath === undefined) {
      delete process.env.PROJECTS_PATH;
    } else {
      process.env.PROJECTS_PATH = previousProjectsPath;
    }
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }
    if (previousAutoTestTrigger === undefined) {
      delete process.env.TASK_AUTOTEST_HTTP_TRIGGER;
    } else {
      process.env.TASK_AUTOTEST_HTTP_TRIGGER = previousAutoTestTrigger;
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('calls /api/tasks/:id/test when status changes to testing', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;

    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-auto-test';
    const agentId = 'agent-auto-test';
    const taskId = 'task-auto-test';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-auto-test', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Agent', 'Builder', '🛠️', 'standby', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Web44',
        'Build a simple page',
        'in_progress',
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
    const response = await route.PATCH(
      new NextRequest(`http://localhost/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'testing' }),
      }),
      { params: Promise.resolve({ id: taskId }) },
    );

    const payload = (await response.json()) as { status?: string };

    expect(response.status).toBe(200);
    expect(payload.status).toBe('testing');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      `http://localhost:3000/api/tasks/${taskId}/test`,
      expect.objectContaining({ method: 'POST' }),
    );

    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    expect(task?.status).toBe('testing');
  });
});
