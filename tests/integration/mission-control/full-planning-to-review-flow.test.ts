import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Mission Control full flow: create -> planning -> answer -> dispatch -> review', () => {
  let tempDir = '';
  let previousDatabasePath: string | undefined;
  let previousProjectsPath: string | undefined;
  let previousPort: string | undefined;
  let previousAutoTestTrigger: string | undefined;
  let originalFetch: typeof fetch | undefined;
  let pollCallCount = 0;

  beforeEach(() => {
    vi.resetModules();
    previousDatabasePath = process.env.DATABASE_PATH;
    previousProjectsPath = process.env.PROJECTS_PATH;
    previousPort = process.env.PORT;
    previousAutoTestTrigger = process.env.TASK_AUTOTEST_HTTP_TRIGGER;
    originalFetch = global.fetch;
    pollCallCount = 0;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-full-flow-'));
    process.env.DATABASE_PATH = path.join(tempDir, 'mission-control.db');
    process.env.PROJECTS_PATH = path.join(tempDir, 'projects');
    process.env.PORT = '3000';
    process.env.TASK_AUTOTEST_HTTP_TRIGGER = 'true';

    vi.doMock('@/server/skills/skillRepository', () => ({
      getSkillRepository: async () => ({
        listSkills: () => [{ installed: true }],
      }),
    }));

    vi.doMock('@/lib/openclaw/client', () => ({
      getOpenClawClient: () => ({
        isConnected: () => true,
        connect: async () => {},
        call: async (_method: string, payload: { idempotencyKey?: string }) => {
          const key = String(payload?.idempotencyKey || '');
          if (key.startsWith('dispatch-')) {
            return {
              userMsgId: 'user-dispatch',
              agentMsgId: 'agent-dispatch',
              conversationId: 'conv-dispatch',
              agentContent: 'TASK_COMPLETE: Implemented webpage and saved index.html',
              agentMetadata: { ok: true, executedToolCalls: 2 },
            };
          }
          return {
            userMsgId: 'user-plan',
            agentMsgId: 'agent-plan',
            conversationId: 'conv-plan',
          };
        },
      }),
    }));

    vi.doMock('@/lib/planning-utils', async () => {
      const actual =
        await vi.importActual<typeof import('@/lib/planning-utils')>('@/lib/planning-utils');
      return {
        ...actual,
        getMessagesFromOpenClaw: vi.fn(async () => {
          pollCallCount += 1;
          if (pollCallCount === 1) {
            return [
              {
                role: 'assistant',
                content: JSON.stringify({
                  question: 'Welche Art von Webseite soll erstellt werden?',
                  options: [
                    { id: 'A', label: 'Einfache HTML-Seite mit Hallo' },
                    { id: 'B', label: 'Landingpage mit mehreren Sektionen' },
                    { id: 'other', label: 'Andere' },
                  ],
                }),
              },
            ];
          }
          return [
            {
              role: 'assistant',
              content: JSON.stringify({
                question: 'Welche Art von Webseite soll erstellt werden?',
                options: [
                  { id: 'A', label: 'Einfache HTML-Seite mit Hallo' },
                  { id: 'B', label: 'Landingpage mit mehreren Sektionen' },
                  { id: 'other', label: 'Andere' },
                ],
              }),
            },
            {
              role: 'assistant',
              content: JSON.stringify({
                status: 'complete',
                spec: {
                  title: 'Simple Hallo Page',
                  summary: 'Create a simple HTML webpage showing Hallo.',
                  deliverables: ['index.html'],
                  success_criteria: ['Browser displays Hallo text'],
                },
                agents: [{ name: 'Web Builder', role: 'Frontend Dev', avatar_emoji: '🛠️' }],
                execution_plan: {
                  approach: 'Create one static html file',
                  steps: ['Create index.html', 'Render Hallo text'],
                },
              }),
            },
          ];
        }),
      };
    });

    vi.doMock('playwright', () => ({
      chromium: {
        launch: async () => ({
          newContext: async () => ({
            newPage: async () => ({
              on: vi.fn(),
              goto: async () => ({ status: () => 200 }),
              waitForTimeout: async () => {},
              screenshot: async () => {},
            }),
            close: async () => {},
          }),
          close: async () => {},
        }),
      },
    }));
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

  it('reaches review after planning answers and execution flow', async () => {
    const { run, queryOne, queryAll } = await import('@/lib/db');
    const now = new Date().toISOString();
    const workspaceId = 'workspace-full-flow';

    run(
      `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, 'Mission Workspace', 'mission-workspace', null, '📁', now, now],
    );

    const projectDir = path.join(process.env.PROJECTS_PATH!, 'web-review-flow');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'index.html'),
      '<!doctype html><html><body><h1>Hallo</h1></body></html>',
      'utf-8',
    );

    const createRoute = await import('../../../app/api/tasks/route');
    const createRes = await createRoute.POST(
      new NextRequest('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Web Review Flow',
          description: 'Erstelle eine einfache Webseite',
          status: 'inbox',
          priority: 'normal',
          assigned_agent_id: null,
          workspace_id: workspaceId,
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createdTask = (await createRes.json()) as { id: string };
    const taskId = createdTask.id;
    expect(taskId).toBeTruthy();

    global.fetch = vi.fn(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      const dispatchMatch = url.match(/\/api\/tasks\/([^/]+)\/dispatch$/);
      if (dispatchMatch) {
        const route = await import('../../../app/api/tasks/[id]/dispatch/route');
        return route.POST(
          new NextRequest(url, {
            method: init?.method || 'POST',
            headers: init?.headers,
            body: (init?.body as BodyInit | null | undefined) ?? null,
          }),
          { params: Promise.resolve({ id: dispatchMatch[1] }) },
        );
      }

      const testMatch = url.match(/\/api\/tasks\/([^/]+)\/test$/);
      if (testMatch) {
        const route = await import('../../../app/api/tasks/[id]/test/route');
        return route.POST(
          new NextRequest(url, {
            method: init?.method || 'POST',
            headers: init?.headers,
            body: (init?.body as BodyInit | null | undefined) ?? null,
          }),
          { params: Promise.resolve({ id: testMatch[1] }) },
        );
      }

      throw new Error(`Unexpected fetch URL in full-flow test: ${url}`);
    }) as typeof fetch;

    const planningRoute = await import('../../../app/api/tasks/[id]/planning/route');
    const planningPollRoute = await import('../../../app/api/tasks/[id]/planning/poll/route');
    const planningAnswerRoute = await import('../../../app/api/tasks/[id]/planning/answer/route');

    const startRes = await planningRoute.POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/planning`, { method: 'POST' }),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(startRes.status).toBe(200);

    const firstPollRes = await planningPollRoute.GET(
      new NextRequest(`http://localhost/api/tasks/${taskId}/planning/poll`),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(firstPollRes.status).toBe(200);
    const firstPoll = (await firstPollRes.json()) as {
      hasUpdates?: boolean;
      complete?: boolean;
      currentQuestion?: { question?: string; options?: Array<{ id: string; label: string }> };
    };
    expect(firstPoll.hasUpdates).toBe(true);
    expect(firstPoll.complete).toBe(false);
    expect(firstPoll.currentQuestion?.question).toContain('Welche Art von Webseite');
    expect(firstPoll.currentQuestion?.options?.length).toBeGreaterThan(0);

    const answerRes = await planningAnswerRoute.POST(
      new NextRequest(`http://localhost/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: 'A' }),
      }),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(answerRes.status).toBe(200);

    const secondPollRes = await planningPollRoute.GET(
      new NextRequest(`http://localhost/api/tasks/${taskId}/planning/poll`),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(secondPollRes.status).toBe(200);
    const secondPoll = (await secondPollRes.json()) as {
      complete?: boolean;
      autoDispatched?: boolean;
      dispatchError?: string | null;
    };
    expect(secondPoll.complete).toBe(true);
    expect(secondPoll.autoDispatched).toBe(true);
    expect(secondPoll.dispatchError).toBeNull();

    let finalTask = queryOne<{
      status: string;
      planning_complete: number;
      assigned_agent_id: string | null;
    }>('SELECT status, planning_complete, assigned_agent_id FROM tasks WHERE id = ?', [taskId]);

    for (let i = 0; i < 20 && finalTask?.status !== 'review'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finalTask = queryOne<{
        status: string;
        planning_complete: number;
        assigned_agent_id: string | null;
      }>('SELECT status, planning_complete, assigned_agent_id FROM tasks WHERE id = ?', [taskId]);
    }

    expect(finalTask?.planning_complete).toBe(1);
    expect(finalTask?.assigned_agent_id).toBeTruthy();
    expect(finalTask?.status).toBe('review');

    const deliverables = queryAll<{ id: string; path: string }>(
      'SELECT id, path FROM task_deliverables WHERE task_id = ?',
      [taskId],
    );
    expect(deliverables.length).toBeGreaterThan(0);
    expect(deliverables[0]?.path.endsWith('index.html')).toBe(true);

    const testActivities = queryAll<{ activity_type: string }>(
      "SELECT activity_type FROM task_activities WHERE task_id = ? AND activity_type IN ('test_passed', 'test_failed')",
      [taskId],
    );
    expect(testActivities.length).toBeGreaterThan(0);
  });
});
