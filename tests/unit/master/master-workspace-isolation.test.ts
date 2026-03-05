import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

describe('master workspace isolation', () => {
  const cleanupPaths: string[] = [];
  let previousPersonasDbPath: string | undefined;
  let previousPersonasRootPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousPersonasDbPath = process.env.PERSONAS_DB_PATH;
    previousPersonasRootPath = process.env.PERSONAS_ROOT_PATH;

    const personasRoot = path.resolve(
      getTestArtifactsRoot(),
      `master.scope.personas.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    const personasDbPath = path.resolve(
      getTestArtifactsRoot(),
      `master.scope.personas.${Date.now()}.${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.PERSONAS_ROOT_PATH = personasRoot;
    process.env.PERSONAS_DB_PATH = personasDbPath;
    cleanupPaths.push(personasRoot, personasDbPath);
  });

  afterEach(() => {
    delete process.env.MASTER_SYSTEM_PERSONA_ENABLED;
    if (previousPersonasDbPath === undefined) {
      delete process.env.PERSONAS_DB_PATH;
    } else {
      process.env.PERSONAS_DB_PATH = previousPersonasDbPath;
    }
    if (previousPersonasRootPath === undefined) {
      delete process.env.PERSONAS_ROOT_PATH;
    } else {
      process.env.PERSONAS_ROOT_PATH = previousPersonasRootPath;
    }

    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (fs.existsSync(target)) {
        try {
          const stat = fs.statSync(target);
          if (stat.isDirectory()) {
            fs.rmSync(target, { recursive: true, force: true });
          } else {
            fs.unlinkSync(target);
          }
        } catch {
          // ignore transient locks on sqlite files on Windows
        }
      }
    }
  });

  it('requires workspace binding, provisions Master automatically, and denies out-of-root cwd', async () => {
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'true';
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');

    expect(() =>
      resolveMasterWorkspaceScope({
        userId: 'user-1',
      }),
    ).toThrow(/workspaceId is required/i);

    const scope = resolveMasterWorkspaceScope({
      userId: 'user-1',
      workspaceId: 'w1',
    });

    expect(scope.personaId).toBeTruthy();
    expect(scope.workspaceId).toMatch(/^persona:[^:]+:w1$/);
    expect(scope.workspaceCwd).toContain(path.join('master', 'projects', 'workspaces', 'w1'));

    expect(() =>
      resolveMasterWorkspaceScope({
        userId: 'user-1',
        workspaceId: 'w1',
        workspaceCwd: path.resolve(process.cwd(), '..'),
      }),
    ).toThrow(/inside master workspace root/i);
  });

  it('binds scope to the Master workspace root and normalizes legacy persona ids', async () => {
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'true';
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { getPersonaWorkspaceDir } = await import('@/server/personas/personaWorkspace');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');

    const legacyPersona = getPersonaRepository().createPersona({
      userId: 'user-2',
      name: 'Researcher',
      emoji: 'R',
      vibe: 'deep',
    });
    const masterPersona = ensureMasterPersona('user-2');
    const personaRoot = getPersonaWorkspaceDir(masterPersona.slug);
    const projectPath = path.join(personaRoot, 'projects', 'workspaces', 'task-42');

    const scope = resolveMasterWorkspaceScope({
      userId: 'user-2',
      personaId: legacyPersona.id,
      workspaceId: 'task-42',
      workspaceCwd: projectPath,
    });

    expect(scope.userId).toBe('user-2');
    expect(scope.personaId).toBe(masterPersona.id);
    expect(scope.workspaceId).toBe(`persona:${masterPersona.id}:task-42`);
    expect(scope.workspaceCwd).toBe(path.resolve(projectPath));
    expect(scope.personaWorkspaceRoot).toBe(path.resolve(personaRoot));
    expect(fs.existsSync(scope.workspaceCwd)).toBe(true);
  });

  it('falls back to the requested legacy persona workspace while the rollout flag is disabled', async () => {
    process.env.MASTER_SYSTEM_PERSONA_ENABLED = 'false';
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { getPersonaWorkspaceDir } = await import('@/server/personas/personaWorkspace');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');

    const legacyPersona = getPersonaRepository().createPersona({
      userId: 'user-legacy',
      name: 'Researcher',
      emoji: 'R',
      vibe: 'deep',
    });
    const legacyRoot = path.resolve(getPersonaWorkspaceDir(legacyPersona.slug));

    const scope = resolveMasterWorkspaceScope({
      userId: 'user-legacy',
      personaId: legacyPersona.id,
      workspaceId: 'ops',
    });

    expect(scope.personaId).toBe(legacyPersona.id);
    expect(scope.workspaceId).toBe(`persona:${legacyPersona.id}:ops`);
    expect(scope.personaWorkspaceRoot).toBe(legacyRoot);
    expect(scope.workspaceCwd).toContain(
      path.join(legacyPersona.slug, 'projects', 'workspaces', 'ops'),
    );
  });
});
