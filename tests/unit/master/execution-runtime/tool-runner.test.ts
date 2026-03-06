import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonaRepository } from '@/server/personas/personaRepository';
import { SqliteMasterRepository } from '@/server/master/repository/sqliteMasterRepository';
import { getTestArtifactsRoot } from '../../../helpers/testArtifacts';

describe('master tool runner', () => {
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

  it('creates notes directly and returns approval_required for shell execution without bypass', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    process.env.PERSONAS_ROOT_PATH = path.resolve(getTestArtifactsRoot(), `tool.runner.${suffix}`);
    process.env.PERSONAS_DB_PATH = path.resolve(getTestArtifactsRoot(), `tool.runner.${suffix}.db`);
    cleanupDirs.push(String(process.env.PERSONAS_ROOT_PATH));
    cleanupFiles.push(String(process.env.PERSONAS_DB_PATH));

    const { ensureMasterPersona } = await import('@/server/master/systemPersona');
    const personaRepo = new PersonaRepository(String(process.env.PERSONAS_DB_PATH));
    const master = ensureMasterPersona('user-master', personaRepo);
    const repo = new SqliteMasterRepository(':memory:');
    const { runTool } = await import('@/server/master/execution/runtime/toolRunner');

    const scope = {
      userId: 'user-master',
      workspaceId: `persona:${master.id}:main`,
      personaId: master.id,
      personaWorkspaceRoot: path.resolve(String(process.env.PERSONAS_ROOT_PATH), 'master'),
      workspaceCwd: path.resolve(String(process.env.PERSONAS_ROOT_PATH), 'master', 'workspace'),
    };
    const run = repo.createRun({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      title: 'Tool runner',
      contract: 'create notes and maybe shell',
    });

    const noteResult = await runTool({
      scope,
      run,
      repo,
      stepId: 'step-note',
      request: {
        toolName: 'notes',
        actionType: 'notes',
        fingerprint: 'notes',
        requiresApproval: false,
      },
      approvalBypass: false,
    });
    expect(noteResult.status).toBe('completed');
    expect(repo.listNotes(scope)).toHaveLength(1);

    const shellResult = await runTool({
      scope,
      run,
      repo,
      stepId: 'step-shell',
      request: {
        toolName: 'shell_execute',
        actionType: 'shell.exec',
        fingerprint: 'shell.exec',
        requiresApproval: true,
        command: 'npm install',
      },
      approvalBypass: false,
    });
    expect(shellResult.status).toBe('approval_required');
    personaRepo.close();
    repo.close();
  });
});
