import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

interface MockAutomationRule {
  id: string;
  userId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
}

const automationState: { rules: MockAutomationRule[] } = { rules: [] };

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

function mockAutomationRuntime(): void {
  automationState.rules = [];
  vi.doMock('../../../src/server/automation/runtime', () => ({
    getAutomationService: () => ({
      createRule(input: {
        userId: string;
        name: string;
        cronExpression: string;
        timezone: string;
        prompt: string;
        enabled: boolean;
      }) {
        const rule: MockAutomationRule = {
          id: `rule-${automationState.rules.length + 1}`,
          userId: input.userId,
          name: input.name,
          cronExpression: input.cronExpression,
          timezone: input.timezone,
          prompt: input.prompt,
          enabled: input.enabled,
          nextRunAt: input.enabled ? '2026-03-07T03:00:00.000Z' : null,
        };
        automationState.rules.push(rule);
        return rule;
      },
      updateRule(ruleId: string, userId: string, patch: Partial<MockAutomationRule>) {
        const rule = automationState.rules.find(
          (entry) => entry.id === ruleId && entry.userId === userId,
        );
        if (!rule) return null;
        Object.assign(rule, patch);
        if (patch.enabled === false && patch.nextRunAt === undefined) {
          rule.nextRunAt = null;
        }
        return rule;
      },
      deleteRule(ruleId: string, userId: string) {
        const index = automationState.rules.findIndex(
          (entry) => entry.id === ruleId && entry.userId === userId,
        );
        if (index < 0) return false;
        automationState.rules.splice(index, 1);
        return true;
      },
      listRules(userId: string) {
        return automationState.rules.filter((entry) => entry.userId === userId);
      },
    }),
  }));
}

describe('master reminders lifecycle routes', () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.MASTER_DB_PATH;
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.PERSONAS_ROOT_PATH;

    try {
      const runtime = await import('@/server/master/runtime');
      runtime.resetMasterRepositoryForTests();
    } catch {
      // ignore cleanup if runtime was not imported
    }

    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (!fs.existsSync(target)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.rmSync(target, { force: true });
      } catch {
        // ignore transient sqlite locks on windows
      }
    }
  });

  it('creates, updates, and cancels reminders through the detail route', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.MASTER_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.reminders.${suffix}.db`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.reminders.personas.${suffix}.db`,
    );
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.reminders.personas.root.${suffix}`,
    );
    cleanupPaths.push(
      String(process.env.MASTER_DB_PATH),
      String(process.env.PERSONAS_DB_PATH),
      String(process.env.PERSONAS_ROOT_PATH),
    );

    mockUserContext({ userId: 'legacy-local-user', authenticated: true });
    mockAutomationRuntime();
    const collectionRoute = await import('../../../app/api/master/reminders/route');
    const detailRoute = await import('../../../app/api/master/reminders/[id]/route');

    const createResponse = await collectionRoute.POST(
      new Request('http://localhost/api/master/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'w-reminders-routes',
          title: 'Rotate backup key',
          message: 'Update the offsite rotation secret',
          remindAt: '2026-03-07T03:00:00.000Z',
          cronExpression: '0 3 * * *',
        }),
      }),
    );
    expect(createResponse.status).toBe(201);
    const createPayload = (await createResponse.json()) as {
      reminder: { id: string; status: string; workspaceId: string };
    };

    const pauseResponse = await detailRoute.PATCH(
      new Request(`http://localhost/api/master/reminders/${createPayload.reminder.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'w-reminders-routes',
          status: 'paused',
        }),
      }),
      { params: Promise.resolve({ id: createPayload.reminder.id }) },
    );
    expect(pauseResponse.status).toBe(200);
    await expect(pauseResponse.json()).resolves.toMatchObject({
      ok: true,
      reminder: { id: createPayload.reminder.id, status: 'paused' },
    });

    const cancelResponse = await detailRoute.PATCH(
      new Request(`http://localhost/api/master/reminders/${createPayload.reminder.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'w-reminders-routes',
          status: 'cancelled',
        }),
      }),
      { params: Promise.resolve({ id: createPayload.reminder.id }) },
    );
    expect(cancelResponse.status).toBe(200);
    await expect(cancelResponse.json()).resolves.toMatchObject({
      ok: true,
      reminder: { id: createPayload.reminder.id, status: 'cancelled' },
    });
  });

  it('fires reminders through the fire route and suppresses duplicate callbacks', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.MASTER_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.reminders.fire.${suffix}.db`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.reminders.fire.personas.${suffix}.db`,
    );
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.reminders.fire.personas.root.${suffix}`,
    );
    cleanupPaths.push(
      String(process.env.MASTER_DB_PATH),
      String(process.env.PERSONAS_DB_PATH),
      String(process.env.PERSONAS_ROOT_PATH),
    );

    mockUserContext({ userId: 'legacy-local-user', authenticated: true });
    mockAutomationRuntime();
    const collectionRoute = await import('../../../app/api/master/reminders/route');
    const fireRoute = await import('../../../app/api/master/reminders/[id]/fire/route');
    const runtime = await import('@/server/master/runtime');

    const createResponse = await collectionRoute.POST(
      new Request('http://localhost/api/master/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'w-reminders-fire',
          title: 'Check backups',
          message: 'Inspect the overnight backup result',
          remindAt: '2026-03-07T01:00:00.000Z',
          cronExpression: '0 1 * * *',
        }),
      }),
    );
    const createPayload = (await createResponse.json()) as {
      reminder: { id: string; status: string; workspaceId: string };
    };

    const firstFireResponse = await fireRoute.POST(
      new Request(`http://localhost/api/master/reminders/${createPayload.reminder.id}/fire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'w-reminders-fire',
          firedAt: '2026-03-07T01:00:00.000Z',
          source: 'cron',
          automationRuleId: automationState.rules[0]?.id,
          summary: 'Backup run completed',
        }),
      }),
      { params: Promise.resolve({ id: createPayload.reminder.id }) },
    );
    expect(firstFireResponse.status).toBe(200);
    await expect(firstFireResponse.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      reminder: { id: createPayload.reminder.id, status: 'fired' },
    });

    const duplicateFireResponse = await fireRoute.POST(
      new Request(`http://localhost/api/master/reminders/${createPayload.reminder.id}/fire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'w-reminders-fire',
          firedAt: '2026-03-07T01:00:00.000Z',
          source: 'cron',
          automationRuleId: automationState.rules[0]?.id,
          summary: 'Backup run completed again',
        }),
      }),
      { params: Promise.resolve({ id: createPayload.reminder.id }) },
    );
    expect(duplicateFireResponse.status).toBe(200);
    await expect(duplicateFireResponse.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      reminder: { id: createPayload.reminder.id, status: 'fired' },
    });

    const auditEvents = runtime
      .getMasterRepository()
      .listAuditEvents({
        userId: 'legacy-local-user',
        workspaceId: createPayload.reminder.workspaceId,
      })
      .filter((entry) => entry.action === 'fired');
    expect(auditEvents).toHaveLength(1);
  });
});
