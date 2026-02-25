import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control planning poll auto-dispatch', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousPort: string | undefined;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousPort = process.env.PORT;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-planning-dispatch-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    process.env.PORT = '3000';
    originalFetch = global.fetch;
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
    if (previousPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = previousPort;
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('assigns the first planned agent before dispatch so planning completion can dispatch successfully', async () => {
    vi.doMock('@/server/skills/skillRepository', () => ({
      getSkillRepository: async () => ({
        listSkills: () => [{ installed: true }],
      }),
    }));

    vi.doMock('@/lib/openclaw/client', () => ({
      getOpenClawClient: () => ({
        isConnected: () => true,
        connect: async () => {},
        call: async () => ({
          userMsgId: 'msg-user',
          agentMsgId: 'msg-agent',
          conversationId: 'conv-1',
        }),
      }),
    }));

    vi.doMock('@/lib/planning-utils', async () => {
      const actual =
        await vi.importActual<typeof import('@/lib/planning-utils')>('@/lib/planning-utils');
      return {
        ...actual,
        getMessagesFromOpenClaw: vi.fn(async () => [
          {
            role: 'assistant',
            content: JSON.stringify({
              status: 'complete',
              spec: { title: 'WebApp' },
              agents: [{ name: 'Builder', role: 'Frontend Dev', avatar_emoji: '🛠️' }],
              execution_plan: { phases: ['build'] },
            }),
          },
        ]),
      };
    });

    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const taskId = 'task-planning-1';
    const workspaceId = 'workspace-1';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace', null, '📁', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, planning_session_key, planning_messages, planning_complete, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Ship landing page',
        'Implement website',
        'planning',
        'normal',
        null,
        null,
        workspaceId,
        'default',
        `agent:main:planning:${taskId}`,
        JSON.stringify([]),
        0,
        now,
        now,
      ],
    );

    global.fetch = vi.fn(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      const match = url.match(/\/api\/tasks\/([^/]+)\/dispatch$/);
      if (!match) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }

      const { POST } = await import('../../../app/api/tasks/[id]/dispatch/route');
      return POST(
        new NextRequest(url, {
          method: init?.method || 'POST',
          headers: init?.headers,
          body: init?.body as BodyInit | null | undefined,
        }),
        { params: Promise.resolve({ id: match[1] }) },
      );
    }) as typeof fetch;

    const { GET } = await import('../../../app/api/tasks/[id]/planning/poll/route');
    const response = await GET(
      new NextRequest(`http://localhost/api/tasks/${taskId}/planning/poll`),
      {
        params: Promise.resolve({ id: taskId }),
      },
    );
    const payload = (await response.json()) as {
      complete?: boolean;
      dispatchError?: string | null;
      autoDispatched?: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload.complete).toBe(true);
    expect(payload.autoDispatched).toBe(true);
    expect(payload.dispatchError).toBeNull();

    const updatedTask = queryOne<{
      assigned_agent_id: string | null;
      planning_complete: number;
      planning_dispatch_error: string | null;
      status: string;
    }>(
      'SELECT assigned_agent_id, planning_complete, planning_dispatch_error, status FROM tasks WHERE id = ?',
      [taskId],
    );

    expect(updatedTask?.assigned_agent_id).toBeTruthy();
    expect(updatedTask?.planning_complete).toBe(1);
    expect(updatedTask?.planning_dispatch_error).toBeNull();
    expect(updatedTask?.status).toBe('in_progress');
  });
});
