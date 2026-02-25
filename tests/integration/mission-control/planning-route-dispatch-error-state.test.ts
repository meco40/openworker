import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control planning route dispatch error state', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-planning-dispatch-error-'));
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

  it('treats planning dispatch error as complete planning state on GET', async () => {
    const { run } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-planning-error';
    const taskId = 'task-planning-error';
    const dispatchError = 'Dispatch failed (502): Agent dispatch failed (timeout)';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace', null, '📁', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, planning_session_key, planning_messages, planning_complete, planning_dispatch_error, planning_spec, planning_agents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Planning error task',
        'Task with dispatch error',
        'pending_dispatch',
        'normal',
        null,
        null,
        workspaceId,
        'default',
        `agent:main:planning:${taskId}`,
        JSON.stringify([
          {
            role: 'assistant',
            content: JSON.stringify({
              status: 'complete',
              spec: { title: 'Spec title', summary: 'Spec summary' },
            }),
            timestamp: Date.now(),
          },
        ]),
        0,
        dispatchError,
        JSON.stringify({ title: 'Spec title', summary: 'Spec summary' }),
        JSON.stringify([{ name: 'Builder', role: 'Frontend' }]),
        now,
        now,
      ],
    );

    const { GET } = await import('../../../app/api/tasks/[id]/planning/route');
    const response = await GET(new NextRequest(`http://localhost/api/tasks/${taskId}/planning`), {
      params: Promise.resolve({ id: taskId }),
    });
    const payload = (await response.json()) as {
      isComplete?: boolean;
      dispatchError?: string;
      currentQuestion?: unknown;
      spec?: { title?: string };
      agents?: Array<{ name: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.isComplete).toBe(true);
    expect(payload.dispatchError).toBe(dispatchError);
    expect(payload.currentQuestion).toBeNull();
    expect(payload.spec?.title).toBe('Spec title');
    expect(payload.agents?.[0]?.name).toBe('Builder');
  });
});
