import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../helpers/testArtifacts';

type MasterGlobals = typeof globalThis & {
  __masterRepository?: unknown;
};

describe('master scope migration', () => {
  const cleanupPaths: string[] = [];
  let previousMasterDbPath: string | undefined;
  let previousPersonasDbPath: string | undefined;
  let previousPersonasRootPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousMasterDbPath = process.env.MASTER_DB_PATH;
    previousPersonasDbPath = process.env.PERSONAS_DB_PATH;
    previousPersonasRootPath = process.env.PERSONAS_ROOT_PATH;

    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.MASTER_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.migrate.${suffix}.db`,
    );
    process.env.PERSONAS_DB_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.migrate.personas.${suffix}.db`,
    );
    process.env.PERSONAS_ROOT_PATH = path.resolve(
      getTestArtifactsRoot(),
      `master.migrate.personas.root.${suffix}`,
    );

    cleanupPaths.push(
      String(process.env.MASTER_DB_PATH),
      String(process.env.PERSONAS_DB_PATH),
      String(process.env.PERSONAS_ROOT_PATH),
    );
    (globalThis as MasterGlobals).__masterRepository = undefined;
  });

  afterEach(async () => {
    if (previousMasterDbPath === undefined) delete process.env.MASTER_DB_PATH;
    else process.env.MASTER_DB_PATH = previousMasterDbPath;
    if (previousPersonasDbPath === undefined) delete process.env.PERSONAS_DB_PATH;
    else process.env.PERSONAS_DB_PATH = previousPersonasDbPath;
    if (previousPersonasRootPath === undefined) delete process.env.PERSONAS_ROOT_PATH;
    else process.env.PERSONAS_ROOT_PATH = previousPersonasRootPath;

    try {
      const runtime = await import('@/server/master/runtime');
      runtime.resetMasterRepositoryForTests();
    } catch {
      // ignore cleanup if runtime was not imported
    }
    (globalThis as MasterGlobals).__masterRepository = undefined;

    for (const target of cleanupPaths.splice(0, cleanupPaths.length)) {
      if (!fs.existsSync(target)) continue;
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
        else fs.unlinkSync(target);
      } catch {
        // ignore transient Windows locks
      }
    }
  });

  it('rewrites legacy persona-scoped master data into the Master system persona scope', async () => {
    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');
    const { getMasterRepository } = await import('@/server/master/runtime');
    const { resolveMasterWorkspaceScope } = await import('@/server/master/workspaceScope');

    const legacyPersona = getPersonaRepository().createPersona({
      userId: 'legacy-local-user',
      name: 'Legacy Builder',
      emoji: 'L',
      vibe: 'strict',
    });
    const masterPersona = ensureMasterPersona('legacy-local-user');
    const repo = getMasterRepository();

    const legacyScope = {
      userId: 'legacy-local-user',
      workspaceId: `persona:${legacyPersona.id}:alpha`,
    };
    repo.createRun({
      userId: legacyScope.userId,
      workspaceId: legacyScope.workspaceId,
      title: 'Legacy run',
      contract: 'migrate me',
    });
    repo.createNote(legacyScope, {
      title: 'Legacy note',
      content: 'carry over',
      tags: ['legacy'],
    });
    repo.upsertApprovalRule(legacyScope, 'gmail.send', 'mail:f1', 'approve_always');
    repo.createApprovalRequest(legacyScope, {
      runId: repo.listRuns(legacyScope)[0]!.id,
      stepId: 'step-legacy-approval',
      toolName: 'shell_execute',
      actionType: 'shell.exec',
      summary: 'Run legacy shell command',
      prompt: 'Allow the legacy shell command?',
      host: 'gateway',
      cwd: 'D:/web/clawtest',
      resolvedPath: 'D:/web/clawtest',
      fingerprint: 'shell_execute:gateway:D:/web/clawtest:legacy',
      riskLevel: 'high',
      status: 'pending',
      expiresAt: '2026-03-06T12:05:00.000Z',
      decision: null,
      decisionReason: null,
      decidedAt: null,
    });
    repo.upsertToolPolicy(legacyScope, {
      security: 'allowlist',
      ask: 'on_miss',
      allowlist: ['shell_execute:gateway:D:/web/clawtest:*'],
      updatedBy: 'legacy-local-user',
    });
    repo.createSubagentSession(legacyScope, {
      runId: repo.listRuns(legacyScope)[0]!.id,
      status: 'queued',
      title: 'Legacy session',
      prompt: 'continue legacy work',
      assignedTools: ['read'],
      ownerId: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      latestEventAt: null,
      resultSummary: null,
      lastError: null,
    });

    const normalizedScope = resolveMasterWorkspaceScope({
      userId: 'legacy-local-user',
      personaId: legacyPersona.id,
      workspaceId: 'alpha',
    });

    expect(normalizedScope.personaId).toBe(masterPersona.id);
    expect(normalizedScope.workspaceId).toBe(`persona:${masterPersona.id}:alpha`);
    expect(repo.listRuns(normalizedScope)).toHaveLength(1);
    expect(repo.listNotes(normalizedScope)).toHaveLength(1);
    expect(repo.getApprovalRule(normalizedScope, 'gmail.send', 'mail:f1')).toBe('approve_always');
    expect(repo.listApprovalRequests(normalizedScope)).toHaveLength(1);
    expect(repo.getToolPolicy(normalizedScope)?.security).toBe('allowlist');
    expect(repo.listSubagentSessions(normalizedScope)).toHaveLength(1);
    expect(repo.listRuns(legacyScope)).toHaveLength(0);
    expect(repo.listNotes(legacyScope)).toHaveLength(0);
    expect(repo.getApprovalRule(legacyScope, 'gmail.send', 'mail:f1')).toBeNull();
    expect(repo.listApprovalRequests(legacyScope)).toHaveLength(0);
    expect(repo.getToolPolicy(legacyScope)).toBeNull();
    expect(repo.listSubagentSessions(legacyScope)).toHaveLength(0);
  });
});
