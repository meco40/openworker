import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonaRepository } from '@/server/personas/personaRepository';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

describe('master system persona provisioning', () => {
  const cleanupDirs: string[] = [];
  const cleanupFiles: string[] = [];

  function createTestPaths(): { personasRootPath: string; dbPath: string } {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const personasRootPath = path.resolve(getTestArtifactsRoot(), `personas.master.${suffix}`);
    const dbPath = path.resolve(getTestArtifactsRoot(), `personas.master.${suffix}.db`);
    cleanupDirs.push(personasRootPath);
    cleanupFiles.push(dbPath);
    process.env.PERSONAS_ROOT_PATH = personasRootPath;
    process.env.PERSONAS_DB_PATH = dbPath;
    return { personasRootPath, dbPath };
  }

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

  it('creates exactly one Master system persona per user with stable defaults', async () => {
    const { personasRootPath, dbPath } = createTestPaths();
    const repo = new PersonaRepository(dbPath);
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');

    const first = ensureMasterPersona('user-master', repo);
    const second = ensureMasterPersona('user-master', repo);

    expect(second.id).toBe(first.id);
    expect(first.systemPersonaKey).toBe('master');
    expect(first.name).toBe('Master');
    expect(first.slug).toBe('master');
    expect(first.isAutonomous).toBe(true);
    expect(first.maxToolCalls).toBeGreaterThanOrEqual(3);
    expect(first.allowedToolFunctionNames.length).toBeGreaterThan(0);
    expect(repo.listPersonas('user-master')).toHaveLength(1);

    for (const filename of ['SOUL.md', 'AGENTS.md', 'USER.md'] as const) {
      const filePath = path.join(personasRootPath, 'master', filename);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).not.toBe('');
    }

    repo.close();
  });

  it('locks Master identity fields while allowing operational settings updates', async () => {
    const { dbPath } = createTestPaths();
    const repo = new PersonaRepository(dbPath);
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');
    const master = ensureMasterPersona('user-master', repo);

    expect(() => repo.updatePersona(master.id, { name: 'Renamed Master' })).toThrow(
      /system persona/i,
    );
    expect(() => repo.deletePersona(master.id)).toThrow(/system persona/i);

    repo.updatePersona(master.id, {
      preferredModelId: 'gpt-4o-mini',
      modelHubProfileId: 'ops-team',
      isAutonomous: false,
      maxToolCalls: 42,
    });

    const updated = repo.getPersona(master.id);
    expect(updated?.name).toBe('Master');
    expect(updated?.preferredModelId).toBe('gpt-4o-mini');
    expect(updated?.modelHubProfileId).toBe('ops-team');
    expect(updated?.isAutonomous).toBe(false);
    expect(updated?.maxToolCalls).toBe(42);

    repo.close();
  });
});
