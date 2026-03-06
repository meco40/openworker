import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

function mockPipelineModels(modelNames: string[]): void {
  vi.doMock('../../../src/server/model-hub/runtime', () => ({
    getModelHubService: () => ({
      listPipeline: () =>
        modelNames.map((modelName, idx) => ({
          id: `m-${idx + 1}`,
          profileId: 'p1',
          accountId: 'acc-1',
          providerId: 'openai',
          modelName,
          priority: idx + 1,
          status: 'active',
        })),
    }),
  }));
}

async function loadMasterSettingsRoute() {
  return import('../../../app/api/master/settings/route');
}

describe('master settings route', () => {
  const cleanupDirs: string[] = [];
  const cleanupFiles: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.MASTER_SYSTEM_PERSONA_ENABLED;
    delete process.env.PERSONAS_ROOT_PATH;
    delete process.env.PERSONAS_DB_PATH;

    for (const dirPath of cleanupDirs.splice(0, cleanupDirs.length)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup races
      }
    }

    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // ignore cleanup races
        }
      }
    }
  });

  it('provisions Master on GET and persists allowed settings on PUT', async () => {
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'true';
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.settings.${suffix}`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.settings.${suffix}.db`,
    );
    cleanupDirs.push(String(process.env.PERSONAS_ROOT_PATH));
    cleanupFiles.push(String(process.env.PERSONAS_DB_PATH));

    mockUserContext({ userId: 'user-master', authenticated: true });
    mockPipelineModels(['gpt-4o-mini', 'claude-3.7-sonnet']);
    const route = await loadMasterSettingsRoute();

    const getResponse = await route.GET(new Request('http://localhost/api/master/settings'));
    expect(getResponse.status).toBe(200);
    const getPayload = (await getResponse.json()) as {
      ok: boolean;
      persona: { id: string; name: string; systemPersonaKey: string | null };
      runtimeSettings: {
        preferredModelId: string | null;
        isAutonomous: boolean;
        maxToolCalls: number;
      };
      allowedToolFunctionNames: string[];
      toolPolicy: {
        security: string;
        ask: string;
        allowlist: string[];
      };
      instructionFiles: Record<string, string>;
    };
    expect(getPayload.ok).toBe(true);
    expect(getPayload.persona.name).toBe('Master');
    expect(getPayload.persona.systemPersonaKey).toBe('master');
    expect(getPayload.allowedToolFunctionNames.length).toBeGreaterThan(0);
    expect(getPayload.toolPolicy.security).toBe('allowlist');
    expect(getPayload.instructionFiles['SOUL.md']).not.toBe('');

    const putResponse = await route.PUT(
      new Request('http://localhost/api/master/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferredModelId: 'claude-3.7-sonnet',
          modelHubProfileId: 'ops-team',
          isAutonomous: false,
          maxToolCalls: 33,
          allowedToolFunctionNames: ['shell_execute', 'web_search'],
          toolPolicy: {
            security: 'full',
            ask: 'always',
            allowlist: ['shell.exec:D:/web/clawtest:*'],
          },
          files: {
            'SOUL.md': 'Master soul override',
            'AGENTS.md': 'Master agents override',
            'USER.md': 'Master user override',
          },
        }),
      }),
    );
    expect(putResponse.status).toBe(200);
    const putPayload = (await putResponse.json()) as {
      ok: boolean;
      runtimeSettings: {
        preferredModelId: string | null;
        modelHubProfileId: string | null;
        isAutonomous: boolean;
        maxToolCalls: number;
      };
      allowedToolFunctionNames: string[];
      toolPolicy: {
        security: string;
        ask: string;
        allowlist: string[];
      };
      instructionFiles: Record<string, string>;
    };
    expect(putPayload.ok).toBe(true);
    expect(putPayload.runtimeSettings.preferredModelId).toBe('claude-3.7-sonnet');
    expect(putPayload.runtimeSettings.modelHubProfileId).toBe('ops-team');
    expect(putPayload.runtimeSettings.isAutonomous).toBe(false);
    expect(putPayload.runtimeSettings.maxToolCalls).toBe(33);
    expect(putPayload.allowedToolFunctionNames).toEqual(['shell_execute', 'web_search']);
    expect(putPayload.toolPolicy).toMatchObject({
      security: 'full',
      ask: 'always',
      allowlist: ['shell.exec:D:/web/clawtest:*'],
    });
    expect(putPayload.instructionFiles['SOUL.md']).toBe('Master soul override');
  });

  it('returns 404 while the Master system persona rollout flag is disabled', async () => {
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'false';
    mockUserContext({ userId: 'user-master', authenticated: true });
    mockPipelineModels(['gpt-4o-mini']);
    const route = await loadMasterSettingsRoute();

    const response = await route.GET(new Request('http://localhost/api/master/settings'));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/disabled/i),
    });
  });
});
