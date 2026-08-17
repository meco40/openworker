import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

describe('master runtime persona config branches', () => {
  const cleanupDirs: string[] = [];
  const cleanupFiles: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PERSONAS_ROOT_PATH;
    delete process.env.PERSONAS_DB_PATH;
    delete process.env.MASTER_SYSTEM_PERSONA_ENABLED;

    for (const dirPath of cleanupDirs.splice(0, cleanupDirs.length)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // ignore transient Windows cleanup races
      }
    }
    for (const filePath of cleanupFiles.splice(0, cleanupFiles.length)) {
      for (const candidate of [
        filePath,
        `${filePath}-wal`,
        `${filePath}-shm`,
        `${filePath}-journal`,
      ]) {
        try {
          fs.rmSync(candidate, { force: true });
        } catch {
          // ignore transient Windows cleanup races
        }
      }
    }
  });

  it('validates persona ownership when the system persona rollout is disabled', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const personasRootPath = path.resolve(getTestArtifactsRoot(), `runtime.persona.${suffix}`);
    const dbPath = path.resolve(getTestArtifactsRoot(), `runtime.persona.${suffix}.db`);
    cleanupDirs.push(personasRootPath);
    cleanupFiles.push(dbPath);
    process.env.PERSONAS_ROOT_PATH = personasRootPath;
    process.env.PERSONAS_DB_PATH = dbPath;
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'false';

    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const repo = getPersonaRepository();
    const persona = repo.createPersona({
      userId: 'user-1',
      name: 'Owned Persona',
      emoji: 'P',
      vibe: 'strict',
    });
    repo.updatePersona(persona.id, {
      modelHubProfileId: 'ops-profile',
      preferredModelId: 'gpt-4.1-mini',
    });
    repo.setAllowedToolFunctionNames(persona.id, ['shell_execute']);
    repo.saveFile(persona.id, 'SOUL.md', 'Owned instructions');

    const { getMasterRuntimePersonaConfig } = await import('@/server/master/runtimePersona');

    expect(() =>
      getMasterRuntimePersonaConfig({
        userId: 'user-1',
      }),
    ).toThrow(/personaId is required/);

    expect(() =>
      getMasterRuntimePersonaConfig({
        userId: 'other-user',
        personaId: persona.id,
      }),
    ).toThrow(/invalid for the current user/);

    const config = getMasterRuntimePersonaConfig({
      userId: 'user-1',
      personaId: persona.id,
    });
    expect(config).toMatchObject({
      personaId: persona.id,
      modelHubProfileId: 'ops-profile',
      preferredModelId: 'gpt-4.1-mini',
      allowedToolFunctionNames: ['shell_execute'],
    });
    expect(config.systemInstruction).toContain('Owned instructions');

    repo.close();
  });

  it('ensures a master persona when the provided personaId does not exist', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const personasRootPath = path.resolve(getTestArtifactsRoot(), `runtime.missing.${suffix}`);
    const dbPath = path.resolve(getTestArtifactsRoot(), `runtime.missing.${suffix}.db`);
    cleanupDirs.push(personasRootPath);
    cleanupFiles.push(dbPath);
    process.env.PERSONAS_ROOT_PATH = personasRootPath;
    process.env.PERSONAS_DB_PATH = dbPath;
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'true';

    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { getMasterRuntimePersonaConfig } = await import('@/server/master/runtimePersona');

    const repo = getPersonaRepository();

    // personaId points to a non-existent persona → resolvedPersona is null → ensureMasterPersona
    const config = getMasterRuntimePersonaConfig({
      userId: 'user-1',
      personaId: 'non-existent-persona-id',
    });
    expect(config.personaId).toBeTruthy();
    expect(config.modelHubProfileId).toBe('p1');

    repo.close();
  });

  it('reuses the provided master persona or ensures one when rollout is enabled', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const personasRootPath = path.resolve(getTestArtifactsRoot(), `runtime.master.${suffix}`);
    const dbPath = path.resolve(getTestArtifactsRoot(), `runtime.master.${suffix}.db`);
    cleanupDirs.push(personasRootPath);
    cleanupFiles.push(dbPath);
    process.env.PERSONAS_ROOT_PATH = personasRootPath;
    process.env.PERSONAS_DB_PATH = dbPath;
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'true';

    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');
    const { getMasterRuntimePersonaConfig } = await import('@/server/master/runtimePersona');

    const repo = getPersonaRepository();
    const regularPersona = repo.createPersona({
      userId: 'user-1',
      name: 'Regular Persona',
      emoji: 'R',
      vibe: 'calm',
    });
    const masterPersona = ensureMasterPersona('user-1', repo);
    repo.updatePersona(masterPersona.id, {
      modelHubProfileId: '',
      preferredModelId: null,
    });
    repo.setAllowedToolFunctionNames(masterPersona.id, ['read_file']);

    const explicit = getMasterRuntimePersonaConfig({
      userId: 'user-1',
      personaId: masterPersona.id,
    });
    expect(explicit.personaId).toBe(masterPersona.id);
    expect(explicit.modelHubProfileId).toBe('p1');

    const fallback = getMasterRuntimePersonaConfig({
      userId: 'user-1',
      personaId: regularPersona.id,
    });
    expect(fallback.personaId).toBe(masterPersona.id);
    expect(Array.isArray(fallback.allowedToolFunctionNames)).toBe(true);
    expect(fallback.allowedToolFunctionNames.length).toBeGreaterThan(0);

    repo.close();
  });
});
