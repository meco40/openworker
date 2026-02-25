import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Task activities route FK guard', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-activities-fk-guard-'));
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

  it('falls back to assigned task agent when request agent_id does not exist', async () => {
    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-1';
    const taskId = 'task-1';
    const assignedAgentId = '11111111-1111-4111-8111-111111111111';
    const unknownAgentId = '22222222-2222-4222-8222-222222222222';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [assignedAgentId, 'Agent A', 'Builder', '🛠️', 'standby', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Task',
        'Task description',
        'in_progress',
        'normal',
        assignedAgentId,
        null,
        workspaceId,
        'default',
        null,
        now,
        now,
      ],
    );

    const { POST } = await import('../../../app/api/tasks/[id]/activities/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/activities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_type: 'completed',
          message: 'Done',
          agent_id: unknownAgentId,
        }),
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
    const payload = (await response.json()) as { id?: string; agent_id?: string };

    expect(response.status).toBe(201);
    expect(payload.agent_id).toBe(assignedAgentId);

    const row = queryOne<{ agent_id: string | null }>(
      'SELECT agent_id FROM task_activities WHERE id = ?',
      [payload.id],
    );
    expect(row?.agent_id).toBe(assignedAgentId);
  });
});
