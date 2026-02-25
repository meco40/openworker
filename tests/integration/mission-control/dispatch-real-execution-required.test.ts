import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control dispatch real execution guard', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousProjectsPath: string | undefined;
  let previousPort: string | undefined;
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousProjectsPath = process.env.PROJECTS_PATH;
    previousPort = process.env.PORT;
    originalFetch = global.fetch;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dispatch-real-exec-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    process.env.PORT = '3000';
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

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('rejects dispatch when agent returns no real tool execution', async () => {
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
          agentMetadata: {
            ok: false,
            status: 'tool_execution_required_unmet',
          },
        }),
      }),
    }));

    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-1';
    const taskId = 'task-dispatch-1';
    const agentId = 'agent-dispatch-1';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Executor', 'Builder', '🛠️', 'standby', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Build page',
        'Create webpage with Hallo text',
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

    const { POST } = await import('../../../app/api/tasks/[id]/dispatch/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
      {
        params: Promise.resolve({ id: taskId }),
      },
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(502);
    expect(payload.error).toContain('real execution');

    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    expect(task?.status).toBe('assigned');
  });

  it('returns explicit error when no skills/tools are installed', async () => {
    vi.doMock('@/server/skills/skillRepository', () => ({
      getSkillRepository: async () => ({
        listSkills: () => [],
      }),
    }));

    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-2';
    const taskId = 'task-dispatch-2';
    const agentId = 'agent-dispatch-2';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-2', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Executor', 'Builder', '🛠️', 'standby', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Build page',
        'Create webpage with Hallo text',
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

    const { POST } = await import('../../../app/api/tasks/[id]/dispatch/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
      {
        params: Promise.resolve({ id: taskId }),
      },
    );
    const payload = (await response.json()) as { error?: string; code?: string };

    expect(response.status).toBe(409);
    expect(payload.code).toBe('no_installed_tools');
    expect(payload.error).toContain('no execution tools');

    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    expect(task?.status).toBe('assigned');
  });

  it('moves task to testing when agent reports TASK_COMPLETE in dispatch response', async () => {
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
          agentContent:
            'TASK_COMPLETE: Built index.html with Hallo text and saved it to output directory.',
          agentMetadata: {
            ok: true,
            executedToolCalls: 2,
          },
        }),
      }),
    }));

    const { run, queryOne, queryAll } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-3';
    const taskId = 'task-dispatch-3';
    const agentId = 'agent-dispatch-3';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-3', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Executor', 'Builder', '🛠️', 'working', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Build page',
        'Create webpage with Hallo text',
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

    const { POST } = await import('../../../app/api/tasks/[id]/dispatch/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
      {
        params: Promise.resolve({ id: taskId }),
      },
    );
    const payload = (await response.json()) as {
      completed?: boolean;
      new_status?: string;
      summary?: string;
    };

    expect(response.status).toBe(200);
    expect(payload.completed).toBe(true);
    expect(payload.new_status).toBe('testing');
    expect(payload.summary).toContain('Built index.html');

    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    expect(task?.status).toBe('testing');

    const agent = queryOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [agentId]);
    expect(agent?.status).toBe('standby');

    const completionEvents = queryAll<{ type: string }>(
      "SELECT type FROM events WHERE task_id = ? AND type = 'task_completed'",
      [taskId],
    );
    expect(completionEvents.length).toBeGreaterThan(0);
  });

  it('auto-registers html deliverables and triggers automated test after TASK_COMPLETE', async () => {
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
          agentContent: 'TASK_COMPLETE: Created index.html',
          agentMetadata: { ok: true, executedToolCalls: 1 },
        }),
      }),
    }));

    process.env.PROJECTS_PATH = path.join(tempDir, 'projects');
    fs.mkdirSync(process.env.PROJECTS_PATH, { recursive: true });
    const projectDir = path.join(process.env.PROJECTS_PATH, 'web44');
    fs.mkdirSync(projectDir, { recursive: true });
    const htmlPath = path.join(projectDir, 'index.html');
    fs.writeFileSync(htmlPath, '<!doctype html><html><body>Hallo</body></html>', 'utf-8');

    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    global.fetch = fetchSpy as typeof fetch;

    const { run, queryAll } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-4';
    const taskId = 'task-dispatch-4';
    const agentId = 'agent-dispatch-4';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-4', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Executor', 'Builder', '🛠️', 'working', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Web44',
        'Create webpage with Hallo text',
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

    const { POST } = await import('../../../app/api/tasks/[id]/dispatch/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
      {
        params: Promise.resolve({ id: taskId }),
      },
    );

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      `http://localhost:3000/api/tasks/${taskId}/test`,
      expect.objectContaining({ method: 'POST' }),
    );

    const deliverables = queryAll<{ path: string }>(
      'SELECT path FROM task_deliverables WHERE task_id = ?',
      [taskId],
    );
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0]?.path).toBe(htmlPath);
  });

  it('treats AI dispatch failed content as dispatch failure and keeps task out of in_progress', async () => {
    vi.doMock('@/server/skills/skillRepository', () => ({
      getSkillRepository: async () => ({
        listSkills: () => [{ installed: true }],
      }),
    }));

    const callSpy = vi.fn(async () => ({
      userMsgId: 'msg-user',
      agentMsgId: 'msg-agent',
      conversationId: 'conv-1',
      agentContent:
        'AI dispatch failed: All models failed: grok-4-fast-reasoning@xai: This operation was aborted',
      agentMetadata: { ok: false },
    }));

    vi.doMock('@/lib/openclaw/client', () => ({
      getOpenClawClient: () => ({
        isConnected: () => true,
        connect: async () => {},
        call: callSpy,
      }),
    }));

    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-5';
    const taskId = 'task-dispatch-5';
    const agentId = 'agent-dispatch-5';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-5', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Executor', 'Builder', '🛠️', 'standby', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Live failure case',
        'Dispatch should fail hard when model abort text is returned',
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

    const { POST } = await import('../../../app/api/tasks/[id]/dispatch/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
      {
        params: Promise.resolve({ id: taskId }),
      },
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(502);
    expect(payload.error).toContain('failed');
    expect(callSpy).toHaveBeenCalledTimes(3);

    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    expect(task?.status).toBe('assigned');
  });

  it('retries transient AI dispatch failure and succeeds when later attempt returns TASK_COMPLETE', async () => {
    vi.doMock('@/server/skills/skillRepository', () => ({
      getSkillRepository: async () => ({
        listSkills: () => [{ installed: true }],
      }),
    }));

    const callSpy = vi
      .fn()
      .mockResolvedValueOnce({
        userMsgId: 'msg-user-1',
        agentMsgId: 'msg-agent-1',
        conversationId: 'conv-1',
        agentContent:
          'AI dispatch failed: All models failed: grok-4-fast-reasoning@xai: This operation was aborted',
        agentMetadata: { ok: false },
      })
      .mockResolvedValueOnce({
        userMsgId: 'msg-user-2',
        agentMsgId: 'msg-agent-2',
        conversationId: 'conv-1',
        agentContent: 'TASK_COMPLETE: Created index.html after retry',
        agentMetadata: { ok: true, executedToolCalls: 1 },
      });

    vi.doMock('@/lib/openclaw/client', () => ({
      getOpenClawClient: () => ({
        isConnected: () => true,
        connect: async () => {},
        call: callSpy,
      }),
    }));

    const { run, queryOne } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-6';
    const taskId = 'task-dispatch-6';
    const agentId = 'agent-dispatch-6';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Workspace', 'workspace-6', null, '📁', now, now],
    );

    run(
      `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, 'Executor', 'Builder', '🛠️', 'standby', 0, workspaceId, 'local', now, now],
    );

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        'Retry case',
        'Dispatch should recover via retry',
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

    const { POST } = await import('../../../app/api/tasks/[id]/dispatch/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/dispatch`, { method: 'POST' }),
      {
        params: Promise.resolve({ id: taskId }),
      },
    );
    const payload = (await response.json()) as { completed?: boolean; new_status?: string };

    expect(response.status).toBe(200);
    expect(payload.completed).toBe(true);
    expect(payload.new_status).toBe('testing');
    expect(callSpy).toHaveBeenCalledTimes(2);

    const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
    expect(task?.status).toBe('testing');
  });
});
