import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTestArtifactsRoot } from '../../../helpers/testArtifacts';

describe('master runtime persona config', () => {
  const cleanupDirs: string[] = [];
  const cleanupFiles: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.PERSONAS_ROOT_PATH;
    delete process.env.PERSONAS_DB_PATH;
    delete (globalThis as { __modelHubService?: unknown }).__modelHubService;

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

  it('uses the Master persona model profile and instructions for planning and code generation', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const personasRootPath = path.resolve(getTestArtifactsRoot(), `master.runtime.${suffix}`);
    const dbPath = path.resolve(getTestArtifactsRoot(), `master.runtime.${suffix}.db`);
    cleanupDirs.push(personasRootPath);
    cleanupFiles.push(dbPath);
    process.env.PERSONAS_ROOT_PATH = personasRootPath;
    process.env.PERSONAS_DB_PATH = dbPath;

    const dispatchWithFallback = vi.fn().mockResolvedValue({
      ok: true,
      text: JSON.stringify({
        capabilities: ['web_search'],
        rationale: 'Use the web',
        verificationChecks: ['non_empty_outputs'],
        riskProfile: 'low',
        requiresApproval: false,
        files: [{ path: 'index.ts', content: 'export const value = 1;' }],
        summary: 'Generated summary',
      }),
    });
    (
      globalThis as {
        __modelHubService?: {
          dispatchWithFallback: typeof dispatchWithFallback;
        };
      }
    ).__modelHubService = {
      dispatchWithFallback,
    };

    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const repo = getPersonaRepository();
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');
    const master = ensureMasterPersona('user-master', repo);
    repo.updatePersona(master.id, {
      modelHubProfileId: 'ops-team',
      preferredModelId: 'gpt-4o-mini',
    });
    repo.saveFile(master.id, 'SOUL.md', 'Master soul instructions');
    repo.saveFile(master.id, 'AGENTS.md', 'Master agent instructions');
    repo.saveFile(master.id, 'USER.md', 'Master user instructions');

    const { buildExecutionPlanWithModel } =
      await import('@/server/master/execution/runtime/executionPlan');
    const { buildCodeGenerationContent } =
      await import('@/server/master/execution/runtime/codeGeneration');

    await buildExecutionPlanWithModel('Research current docs', {
      userId: 'user-master',
      personaId: master.id,
    });
    await buildCodeGenerationContent({
      run: {
        id: 'run-1',
        userId: 'user-master',
        workspaceId: 'persona:ignored:w1',
        title: 'Run',
        contract: 'Implement a module',
        status: 'ANALYZING',
        progress: 0,
        verificationPassed: false,
        resultBundle: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
        pausedForApproval: false,
        pendingApprovalActionType: null,
        cancelledAt: null,
        cancelReason: null,
      },
      filePath: 'master-output/run-1-solution.md',
      scope: { userId: 'user-master', personaId: master.id },
    });

    expect(dispatchWithFallback).toHaveBeenCalledTimes(2);
    expect(dispatchWithFallback).toHaveBeenNthCalledWith(
      1,
      'ops-team',
      '0123456789abcdef0123456789abcdef',
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining('Master soul instructions'),
          }),
          expect.any(Object),
        ],
      }),
    );
    expect(dispatchWithFallback).toHaveBeenNthCalledWith(
      2,
      'ops-team',
      '0123456789abcdef0123456789abcdef',
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining('Master agent instructions'),
          }),
          expect.any(Object),
        ],
      }),
    );

    repo.close();
  });

  it('blocks capability execution when the Master allowlist disallows the underlying tool', async () => {
    const suffix = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const personasRootPath = path.resolve(getTestArtifactsRoot(), `master.runtime.block.${suffix}`);
    const dbPath = path.resolve(getTestArtifactsRoot(), `master.runtime.block.${suffix}.db`);
    cleanupDirs.push(personasRootPath);
    cleanupFiles.push(dbPath);
    process.env.PERSONAS_ROOT_PATH = personasRootPath;
    process.env.PERSONAS_DB_PATH = dbPath;

    const { getPersonaRepository } = await import('@/server/personas/personaRepository');
    const repo = getPersonaRepository();
    const { ensureMasterPersona } = await import('@/server/master/systemPersona');
    const master = ensureMasterPersona('user-master', repo);
    repo.setAllowedToolFunctionNames(master.id, ['shell_execute']);

    const { executeCapabilityTask } =
      await import('@/server/master/execution/runtime/capabilityExecutor');

    const result = await executeCapabilityTask({
      scope: {
        userId: 'user-master',
        workspaceId: 'persona:ignored:w1',
        personaId: master.id,
        personaWorkspaceRoot: path.join(personasRootPath, 'master'),
        workspaceCwd: path.join(personasRootPath, 'master', 'projects', 'workspaces', 'w1'),
      },
      run: {
        id: 'run-1',
        userId: 'user-master',
        workspaceId: 'persona:ignored:w1',
        title: 'Run',
        contract: 'Research docs',
        status: 'ANALYZING',
        progress: 0,
        verificationPassed: false,
        resultBundle: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
        pausedForApproval: false,
        pendingApprovalActionType: null,
        cancelledAt: null,
        cancelReason: null,
      },
      capability: 'web_search',
      stepId: 'step-1',
      repo: {} as never,
      control: {
        requiresApproval: false,
        actionType: 'http.post',
        fingerprint: 'web_search',
      },
      approvalBypass: false,
    });

    expect(result.degradedMode).toBe(true);
    expect(result.output).toContain('not allowed');

    repo.close();
  });
});
