import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';
import { getServerEventBus } from '@/server/events/runtime';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

describe('master events route', () => {
  const cleanupDirs: string[] = [];
  const cleanupFiles: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    getServerEventBus().clearAllSubscribers();
    delete process.env.MASTER_OPERATOR_EVENTS_ENABLED;
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

  it('streams connected event first and forwards matching master.updated events', async () => {
    process.env.MASTER_OPERATOR_EVENTS_ENABLED = 'true';
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'false';
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.events.${suffix}`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.events.${suffix}.db`,
    );
    cleanupDirs.push(String(process.env.PERSONAS_ROOT_PATH));
    cleanupFiles.push(String(process.env.PERSONAS_DB_PATH));

    mockUserContext({ userId: 'user-events', authenticated: true });
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const persona = getPersonaRepository().createPersona({
      userId: 'user-events',
      name: 'Master Events Persona',
      emoji: 'M',
      vibe: 'strict',
    });
    const route = await import('../../../app/api/master/events/route');

    const response = await route.GET(
      new Request(
        `http://localhost/api/master/events?personaId=${encodeURIComponent(persona.id)}&workspaceId=main`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const firstChunk = await reader!.read();
    const firstPayload = new TextDecoder().decode(firstChunk.value);
    expect(firstPayload).toContain('event: connected');
    expect(firstPayload).toContain('"type":"connected"');

    getServerEventBus().publish('master.updated', {
      userId: 'user-events',
      workspaceId: `persona:${persona.id}:main`,
      resources: ['runs', 'metrics'],
      runId: 'run-1',
      at: new Date().toISOString(),
    });

    const secondChunk = await reader!.read();
    const secondPayload = new TextDecoder().decode(secondChunk.value);
    expect(secondPayload).toContain('event: updated');
    expect(secondPayload).toContain('"type":"updated"');
    expect(secondPayload).toContain('"resources":["runs","metrics"]');
    expect(secondPayload).toContain('"runId":"run-1"');
    await reader?.cancel();
  });

  it('returns 404 while operator events are disabled', async () => {
    process.env.MASTER_OPERATOR_EVENTS_ENABLED = 'false';
    mockUserContext({ userId: 'user-events', authenticated: true });
    const route = await import('../../../app/api/master/events/route');

    const response = await route.GET(new Request('http://localhost/api/master/events'));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/disabled/i),
    });
  });
});
