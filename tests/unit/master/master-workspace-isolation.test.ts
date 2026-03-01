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

  it('requires persona/workspace binding and denies out-of-root cwd', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');

    const persona = getPersonaRepository().createPersona({
      userId: 'user-1',
      name: 'Builder',
      emoji: 'B',
      vibe: 'focused',
    });

    expect(() =>
      resolveMasterWorkspaceScope({
        userId: 'user-1',
        workspaceId: 'w1',
      }),
    ).toThrow(/personaId is required/i);

    expect(() =>
      resolveMasterWorkspaceScope({
        userId: 'user-1',
        personaId: persona.id,
      }),
    ).toThrow(/workspaceId is required/i);

    expect(() =>
      resolveMasterWorkspaceScope({
        userId: 'user-1',
        personaId: persona.id,
        workspaceId: 'w1',
        workspaceCwd: path.resolve(process.cwd(), '..'),
      }),
    ).toThrow(/inside persona workspace root/i);
  });

  it('binds scope to persona workspace and canonical workspace id', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { getPersonaWorkspaceDir } = await import('@/server/personas/personaWorkspace');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');

    const persona = getPersonaRepository().createPersona({
      userId: 'user-2',
      name: 'Researcher',
      emoji: 'R',
      vibe: 'deep',
    });
    const personaRoot = getPersonaWorkspaceDir(persona.slug);
    const projectPath = path.join(personaRoot, 'projects', 'master-task');

    const scope = resolveMasterWorkspaceScope({
      userId: 'user-2',
      personaId: persona.id,
      workspaceId: 'task-42',
      workspaceCwd: projectPath,
    });

    expect(scope.userId).toBe('user-2');
    expect(scope.workspaceId).toBe(`persona:${persona.id}:task-42`);
    expect(scope.workspaceCwd).toBe(path.resolve(projectPath));
    expect(scope.personaWorkspaceRoot).toBe(path.resolve(personaRoot));
    expect(fs.existsSync(scope.workspaceCwd)).toBe(true);
  });
});
