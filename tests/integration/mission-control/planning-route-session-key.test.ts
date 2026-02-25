import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control planning route session key', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-planning-session-key-'));
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

  it('creates a unique planning session key per start instead of reusing task-id-only key', async () => {
    const callMock = vi.fn(async () => ({
      userMsgId: 'msg-user',
      agentMsgId: 'msg-agent',
      conversationId: 'conv-1',
    }));

    vi.doMock('@/lib/openclaw/client', () => ({
      getOpenClawClient: () => ({
        isConnected: () => true,
        connect: async () => {},
        call: callMock,
      }),
    }));

    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-1';
    const taskId = 'task-1';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace', null, '📁', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'WebSeite',
        'Erstelle eine WebSeite',
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

    const { POST } = await import('../../../app/api/tasks/[id]/planning/route');
    const response = await POST(new NextRequest(`http://localhost/api/tasks/${taskId}/planning`), {
      params: Promise.resolve({ id: taskId }),
    });
    const payload = (await response.json()) as {
      success?: boolean;
      sessionKey?: string;
      error?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.sessionKey).toMatch(/^agent:main:planning:task-1:[a-z0-9]+-[a-f0-9]+$/);
    expect(payload.sessionKey).not.toBe('agent:main:planning:task-1');

    expect(callMock).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({
        sessionKey: payload.sessionKey,
      }),
    );

    const dbTask = queryOne<{ planning_session_key: string | null }>(
      'SELECT planning_session_key FROM tasks WHERE id = ?',
      [taskId],
    );
    expect(dbTask?.planning_session_key).toBe(payload.sessionKey);
  });
});
