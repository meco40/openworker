import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonaRepository } from '@/server/personas/personaRepository';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

function mockUserContext(context: { userId: string; authenticated: boolean } | null): void {
  vi.doMock('../../../src/server/auth/userContext', () => ({
    resolveRequestUserContext: vi.fn().mockResolvedValue(context),
  }));
}

async function loadPersonaByIdRoute() {
  return import('../../../app/api/personas/[id]/route');
}

async function loadPersonaFileRoute() {
  return import('../../../app/api/personas/[id]/files/[filename]/route');
}

describe('master system persona routes', () => {
  const cleanupDirs: string[] = [];
  const cleanupFiles: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PERSONAS_ROOT_PATH;
    delete process.env.PERSONAS_DB_PATH;

    for (const dirPath of cleanupDirs.splice(0, cleanupDirs.length)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup races in tests
      }
    }

    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // ignore cleanup races in tests
        }
      }
    }
  });

  it('blocks rename and delete through the public persona route for Master', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `personas.master.routes.${suffix}`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `personas.master.routes.${suffix}.db`,
    );
    cleanupDirs.push(String(process.env.PERSONAS_ROOT_PATH));
    cleanupFiles.push(String(process.env.PERSONAS_DB_PATH));

    const repo = new PersonaRepository(String(process.env.PERSONAS_DB_PATH));
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');
    const master = ensureMasterPersona('user-master', repo);
    repo.close();

    mockUserContext({ userId: 'user-master', authenticated: true });
    const route = await loadPersonaByIdRoute();

    const renameResponse = await route.PUT(
      new Request(`http://localhost/api/personas/${master.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed Master' }),
      }),
      { params: Promise.resolve({ id: master.id }) },
    );
    expect(renameResponse.status).toBe(403);

    const deleteResponse = await route.DELETE(
      new Request(`http://localhost/api/personas/${master.id}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: master.id }) },
    );
    expect(deleteResponse.status).toBe(403);
  });

  it('blocks direct metadata and file writes for Master so settings stay centralized', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `personas.master.locked.${suffix}`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `personas.master.locked.${suffix}.db`,
    );
    cleanupDirs.push(String(process.env.PERSONAS_ROOT_PATH));
    cleanupFiles.push(String(process.env.PERSONAS_DB_PATH));

    const repo = new PersonaRepository(String(process.env.PERSONAS_DB_PATH));
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');
    const master = ensureMasterPersona('user-master', repo);
    repo.close();

    mockUserContext({ userId: 'user-master', authenticated: true });
    const personaRoute = await loadPersonaByIdRoute();
    const fileRoute = await loadPersonaFileRoute();

    const metadataResponse = await personaRoute.PUT(
      new Request(`http://localhost/api/personas/${master.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredModelId: 'gpt-4o-mini', isAutonomous: false }),
      }),
      { params: Promise.resolve({ id: master.id }) },
    );
    expect(metadataResponse.status).toBe(403);

    const fileResponse = await fileRoute.PUT(
      new Request(`http://localhost/api/personas/${master.id}/files/SOUL.md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'override' }),
      }),
      { params: Promise.resolve({ id: master.id, filename: 'SOUL.md' }) },
    );
    expect(fileResponse.status).toBe(403);
  });
});
