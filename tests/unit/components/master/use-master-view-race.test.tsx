import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterRun } from '@/modules/master/types';
import { useMasterView } from '@/modules/master/hooks/useMasterView';

const apiMocks = vi.hoisted(() => ({
  fetchMasterSettings: vi.fn(),
  fetchMasterPersonas: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchRuns: vi.fn(),
  fetchMetrics: vi.fn(),
  fetchRunDetail: vi.fn(),
  cancelRun: vi.fn(async () => {}),
  createRun: vi.fn(),
  postRunAction: vi.fn(),
  submitFeedback: vi.fn(async () => {}),
  saveMasterSettings: vi.fn(),
}));

vi.mock('@/modules/master/api', () => ({
  fetchMasterSettings: apiMocks.fetchMasterSettings,
  fetchMasterPersonas: apiMocks.fetchMasterPersonas,
  fetchWorkspaces: apiMocks.fetchWorkspaces,
  fetchRuns: apiMocks.fetchRuns,
  fetchMetrics: apiMocks.fetchMetrics,
  fetchRunDetail: apiMocks.fetchRunDetail,
  cancelRun: apiMocks.cancelRun,
  createRun: apiMocks.createRun,
  isMasterSystemPersonaDisabledError: (error: unknown) =>
    error instanceof Error && /disabled/i.test(error.message),
  postRunAction: apiMocks.postRunAction,
  submitFeedback: apiMocks.submitFeedback,
  saveMasterSettings: apiMocks.saveMasterSettings,
}));

function makeRun(id: string, personaId: string): MasterRun {
  return {
    id,
    userId: 'u1',
    workspaceId: `persona:${personaId}:main`,
    title: `Run ${id}`,
    contract: 'Contract',
    status: 'IDLE',
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
  };
}

function createDeferred<T>() {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (!resolveValue) throw new Error('Deferred resolve missing');
      resolveValue(value);
    },
  };
}

describe('useMasterView race guards', () => {
  beforeEach(() => {
    apiMocks.fetchMasterSettings.mockReset();
    apiMocks.fetchMasterPersonas.mockReset();
    apiMocks.fetchWorkspaces.mockReset();
    apiMocks.fetchRuns.mockReset();
    apiMocks.fetchMetrics.mockReset();
    apiMocks.fetchRunDetail.mockReset();
    apiMocks.fetchMasterSettings.mockResolvedValue({
      persona: {
        id: 'master-1',
        name: 'Master',
        slug: 'master',
        emoji: '🧭',
        systemPersonaKey: 'master',
      },
      runtimeSettings: {
        preferredModelId: 'gpt-4o-mini',
        modelHubProfileId: 'ops-team',
        isAutonomous: true,
        maxToolCalls: 120,
      },
      allowedToolFunctionNames: ['shell_execute', 'web_search'],
      instructionFiles: {
        'SOUL.md': 'Master soul',
        'AGENTS.md': 'Master agents',
        'USER.md': 'Master user',
      },
    });
    apiMocks.fetchWorkspaces.mockResolvedValue([{ id: 'main', name: 'Main', slug: 'main' }]);
    apiMocks.fetchMetrics.mockResolvedValue(null);
    apiMocks.fetchRunDetail.mockResolvedValue(null);
    apiMocks.fetchMasterPersonas.mockResolvedValue([
      {
        id: 'persona-1',
        name: 'Architect',
        slug: 'architect',
        emoji: '🧠',
        systemPersonaKey: null,
      },
    ]);
  });

  it('ignores stale run list responses after workspace switch', async () => {
    const mainRuns = createDeferred<MasterRun[]>();

    apiMocks.fetchRuns.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'main') return mainRuns.promise;
      return Promise.resolve([makeRun('run-secondary', 'master-1')]);
    });

    const { result } = renderHook(() => useMasterView());

    await waitFor(() => {
      expect(apiMocks.fetchRuns).toHaveBeenCalledWith('main', 'master-1', expect.anything());
    });

    act(() => {
      result.current.setWorkspaceId('secondary');
    });

    await waitFor(() => {
      expect(apiMocks.fetchRuns).toHaveBeenCalledWith('secondary', 'master-1', expect.anything());
    });

    await waitFor(() => {
      expect(result.current.runs[0]?.id).toBe('run-secondary');
    });

    mainRuns.resolve([makeRun('run-main', 'master-1')]);

    await waitFor(() => {
      expect(result.current.runs[0]?.id).toBe('run-secondary');
    });
  });

  it('falls back to legacy persona mode when Master system settings are disabled', async () => {
    apiMocks.fetchMasterSettings.mockRejectedValue(new Error('Master system persona is disabled.'));
    apiMocks.fetchRuns.mockResolvedValue([]);

    const { result } = renderHook(() => useMasterView());

    await waitFor(() => {
      expect(apiMocks.fetchMasterPersonas).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(result.current.masterMode).toBe('legacy');
      expect(result.current.selectedPersonaId).toBe('persona-1');
    });

    expect(result.current.masterSettings).toBeNull();
    expect(result.current.availablePersonas).toHaveLength(1);
    expect(result.current.availablePersonas[0]?.id).toBe('persona-1');
  });
});
