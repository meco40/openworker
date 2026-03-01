import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control task workspace lifecycle', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousTaskWorkspacesRoot: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousTaskWorkspacesRoot = process.env.TASK_WORKSPACES_ROOT;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-task-workspaces-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    process.env.TASK_WORKSPACES_ROOT = path.join(tempDir, 'workspaces');
  });

  afterEach(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();

    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousTaskWorkspacesRoot === undefined) {
      delete process.env.TASK_WORKSPACES_ROOT;
    } else {
      process.env.TASK_WORKSPACES_ROOT = previousTaskWorkspacesRoot;
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('creates a task workspace during POST /api/tasks', async () => {
    const { run } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-create-test';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-create-test', null, '📁', now, now],
    );

    const { POST } = await import('../../../app/api/tasks/route');
    const response = await POST(
      new NextRequest('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Create task with workspace',
          priority: 'normal',
          status: 'inbox',
          workspace_id: workspaceId,
        }),
      }),
    );

    const payload = (await response.json()) as { id?: string };
    expect(response.status).toBe(201);
    expect(typeof payload.id).toBe('string');

    const taskWorkspaceDir = path.join(
      String(process.env.TASK_WORKSPACES_ROOT),
      String(payload.id),
    );
    const metadataPath = path.join(taskWorkspaceDir, '.workspace.json');

    expect(fs.existsSync(taskWorkspaceDir)).toBe(true);
    expect(fs.existsSync(path.join(taskWorkspaceDir, 'logs'))).toBe(true);
    expect(fs.existsSync(metadataPath)).toBe(true);

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as {
      taskId?: string;
      type?: string;
      version?: number;
    };
    expect(metadata.taskId).toBe(payload.id);
    expect(metadata.type).toBe('general');
    expect(metadata.version).toBe(1);
  });

  it('deletes the task workspace during DELETE /api/tasks/[id]', async () => {
    const { queryOne, run } = await import('@/lib/db');
    const { ensureTaskWorkspace } = await import('@/server/tasks/taskWorkspace');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-delete-test';
    const taskId = 'task-delete-workspace-test';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-delete-test', null, '📁', now, now],
    );
    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Task with workspace to delete',
        null,
        'inbox',
        'normal',
        null,
        null,
        workspaceId,
        'default',
        null,
        now,
        now,
      ],
    );

    const taskWorkspaceDir = ensureTaskWorkspace(taskId);
    expect(fs.existsSync(taskWorkspaceDir)).toBe(true);

    const route = await import('../../../app/api/tasks/[id]/route');
    const response = await route.DELETE(new NextRequest(`http://localhost/api/tasks/${taskId}`), {
      params: Promise.resolve({ id: taskId }),
    });

    expect(response.status).toBe(200);
    expect(queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [taskId])).toBeUndefined();
    expect(fs.existsSync(taskWorkspaceDir)).toBe(false);
  });
});
