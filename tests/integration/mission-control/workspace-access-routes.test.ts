import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control workspace authorization', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousRequireAuth: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousRequireAuth = process.env.REQUIRE_AUTH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-workspace-authz-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    process.env.REQUIRE_AUTH = 'true';

    vi.doMock('@/server/auth/userContext', () => ({
      isAuthRequired: () => true,
      resolveRequestUserContext: vi.fn(async () => ({
        userId: 'user-a',
        authenticated: true,
      })),
    }));
  });

  afterEach(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();

    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousRequireAuth === undefined) delete process.env.REQUIRE_AUTH;
    else process.env.REQUIRE_AUTH = previousRequireAuth;

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('keeps agents, tasks, workspaces, and events inside the user membership', async () => {
    const { run } = await import('@/lib/db');
    const now = new Date().toISOString();

    run(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
      'owned',
      'Owned',
      'owned',
      now,
      now,
    ]);
    run(`INSERT INTO workspaces (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
      'foreign',
      'Foreign',
      'foreign',
      now,
      now,
    ]);
    run(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`, [
      'owned',
      'user-a',
      'owner',
    ]);
    run(
      `INSERT INTO agents (id, name, role, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ['agent-owned', 'Owned Agent', 'worker', 'owned', now, now],
    );
    run(
      `INSERT INTO agents (id, name, role, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ['agent-foreign', 'Foreign Agent', 'worker', 'foreign', now, now],
    );
    run(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['task-owned', 'Owned Task', 'inbox', 'normal', 'owned', 'default', now, now],
    );
    run(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['task-foreign', 'Foreign Task', 'inbox', 'normal', 'foreign', 'default', now, now],
    );
    run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`, [
      'event-owned',
      'task_created',
      'task-owned',
      'owned',
      now,
    ]);
    run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`, [
      'event-foreign',
      'task_created',
      'task-foreign',
      'foreign',
      now,
    ]);
    run(`INSERT INTO events (id, type, message, created_at) VALUES (?, ?, ?, ?)`, [
      'event-global',
      'system',
      'global',
      now,
    ]);

    const agentsRoute = await import('../../../app/api/agents/route');
    const agentsResponse = await agentsRoute.GET(new NextRequest('http://localhost/api/agents'));
    const agents = (await agentsResponse.json()) as Array<{ id: string }>;
    expect(agentsResponse.status).toBe(200);
    expect(agents.map((agent) => agent.id)).toEqual(['agent-owned']);

    const agentDetailRoute = await import('../../../app/api/agents/[id]/route');
    const foreignAgentResponse = await agentDetailRoute.GET(
      new NextRequest('http://localhost/api/agents/agent-foreign'),
      { params: Promise.resolve({ id: 'agent-foreign' }) },
    );
    expect(foreignAgentResponse.status).toBe(404);

    const taskRoute = await import('../../../app/api/tasks/[id]/route');
    const foreignTaskResponse = await taskRoute.GET(
      new NextRequest('http://localhost/api/tasks/task-foreign'),
      { params: Promise.resolve({ id: 'task-foreign' }) },
    );
    expect(foreignTaskResponse.status).toBe(404);

    const workspacesRoute = await import('../../../app/api/workspaces/route');
    const workspacesResponse = await workspacesRoute.GET(
      new NextRequest('http://localhost/api/workspaces'),
    );
    const workspaces = (await workspacesResponse.json()) as Array<{ id: string }>;
    expect(workspaces.map((workspace) => workspace.id)).toEqual(['owned']);

    const eventsRoute = await import('../../../app/api/events/route');
    const eventsResponse = await eventsRoute.GET(new NextRequest('http://localhost/api/events'));
    const events = (await eventsResponse.json()) as Array<{ id: string }>;
    expect(events.map((event) => event.id).sort()).toEqual(['event-global', 'event-owned']);
  });
});
