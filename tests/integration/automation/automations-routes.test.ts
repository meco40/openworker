import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AutomationGlobals = typeof globalThis & {
  __automationRepository?: unknown;
  __automationService?: unknown;
  __automationRuntime?: unknown;
};

function uniqueDbPath(name: string): string {
  return path.join(
    process.cwd(),
    '.local',
    `${name}.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('automation routes', () => {
  const createdDbFiles: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    process.env.CHAT_PERSISTENT_SESSION_V2 = 'false';
    const dbPath = uniqueDbPath('automation.routes');
    process.env.AUTOMATION_DB_PATH = dbPath;
    createdDbFiles.push(dbPath);

    (globalThis as AutomationGlobals).__automationRepository = undefined;
    (globalThis as AutomationGlobals).__automationService = undefined;
    (globalThis as AutomationGlobals).__automationRuntime = undefined;
  });

  afterEach(() => {
    (globalThis as AutomationGlobals).__automationRepository = undefined;
    (globalThis as AutomationGlobals).__automationService = undefined;
    (globalThis as AutomationGlobals).__automationRuntime = undefined;

    for (const dbFile of createdDbFiles.splice(0, createdDbFiles.length)) {
      if (fs.existsSync(dbFile)) {
        try {
          fs.unlinkSync(dbFile);
        } catch {
          // ignore transient lock
        }
      }
    }
  });

  it('supports CRUD and manual run for automations', async () => {
    const automationsRoute = await import('../../../app/api/automations/route');
    const detailRoute = await import('../../../app/api/automations/[id]/route');
    const runRoute = await import('../../../app/api/automations/[id]/run/route');
    const runsRoute = await import('../../../app/api/automations/[id]/runs/route');

    const createResponse = await automationsRoute.POST(
      new Request('http://localhost/api/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Morning briefing',
          cronExpression: '0 10 * * *',
          timezone: 'UTC',
          prompt: 'Give me a morning briefing',
          enabled: true,
        }),
      }),
    );

    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { ok: boolean; rule: { id: string } };
    expect(created.ok).toBe(true);
    const ruleId = created.rule.id;

    const listResponse = await automationsRoute.GET();
    const listed = (await listResponse.json()) as { ok: boolean; rules: Array<{ id: string }> };
    expect(listed.ok).toBe(true);
    expect(listed.rules.some((rule) => rule.id === ruleId)).toBe(true);

    const patchResponse = await detailRoute.PATCH(
      new Request(`http://localhost/api/automations/${ruleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const patched = (await patchResponse.json()) as { ok: boolean; rule: { enabled: boolean } };
    expect(patched.ok).toBe(true);
    expect(patched.rule.enabled).toBe(false);

    const runResponse = await runRoute.POST(
      new Request(`http://localhost/api/automations/${ruleId}/run`, { method: 'POST' }),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const runPayload = (await runResponse.json()) as { ok: boolean; run: { ruleId: string } };
    expect(runPayload.ok).toBe(true);
    expect(runPayload.run.ruleId).toBe(ruleId);

    const runsResponse = await runsRoute.GET(
      new Request(`http://localhost/api/automations/${ruleId}/runs`),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const runsPayload = (await runsResponse.json()) as { ok: boolean; runs: Array<{ id: string }> };
    expect(runsPayload.ok).toBe(true);
    expect(runsPayload.runs.length).toBeGreaterThan(0);

    const deleteResponse = await detailRoute.DELETE(
      new Request(`http://localhost/api/automations/${ruleId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: ruleId }) },
    );
    const deleted = (await deleteResponse.json()) as { ok: boolean };
    expect(deleted.ok).toBe(true);
  }, 15_000);
});



