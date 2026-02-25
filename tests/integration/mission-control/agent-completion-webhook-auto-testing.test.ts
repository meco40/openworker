import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control agent-completion webhook auto-testing trigger', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousProjectsPath: string | undefined;
  let previousPort: string | undefined;
  let previousWebhookSecret: string | undefined;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousProjectsPath = process.env.PROJECTS_PATH;
    previousPort = process.env.PORT;
    previousWebhookSecret = process.env.WEBHOOK_SECRET;
    originalFetch = global.fetch;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-webhook-auto-test-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    process.env.PROJECTS_PATH = path.join(tempDir, 'projects');
    process.env.PORT = '3000';
    delete process.env.WEBHOOK_SECRET;
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
    if (previousWebhookSecret === undefined) {
      delete process.env.WEBHOOK_SECRET;
    } else {
      process.env.WEBHOOK_SECRET = previousWebhookSecret;
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('triggers /api/tasks/:id/test when task completion webhook sets task to testing', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;

    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-webhook-1';
    const agentId = 'agent-webhook-1';
    const taskId = 'task-webhook-1';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-webhook', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Agent', 'Builder', '🛠️', 'working', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Web44',
        'Build page',
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

    const { POST } = await import('../../../app/api/webhooks/agent-completion/route');
    const response = await POST(
      new NextRequest('http://localhost/api/webhooks/agent-completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId, summary: 'Completed task' }),
      }),
    );

    const payload = (await response.json()) as { new_status?: string };

    expect(response.status).toBe(200);
    expect(payload.new_status).toBe('testing');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      `http://localhost:3000/api/tasks/${taskId}/test`,
      expect.objectContaining({ method: 'POST' }),
    );

    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    expect(task?.status).toBe('testing');

    const agent = queryOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [agentId]);
    expect(agent?.status).toBe('standby');
  });
});
