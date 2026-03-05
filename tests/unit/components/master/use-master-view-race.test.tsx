import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterRun } from '@/modules/master/types';
import { useMasterView } from '@/modules/master/hooks/useMasterView';

const apiMocks = vi.hoisted(() => ({
  fetchPersonas: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchRuns: vi.fn(),
  fetchMetrics: vi.fn(),
  fetchRunDetail: vi.fn(),
  cancelRun: vi.fn(async () => {}),
  createRun: vi.fn(),
  postRunAction: vi.fn(),
  submitFeedback: vi.fn(async () => {}),
}));

vi.mock('@/modules/master/api', () => ({
  fetchPersonas: apiMocks.fetchPersonas,
  fetchWorkspaces: apiMocks.fetchWorkspaces,
  fetchRuns: apiMocks.fetchRuns,
  fetchMetrics: apiMocks.fetchMetrics,
  fetchRunDetail: apiMocks.fetchRunDetail,
  cancelRun: apiMocks.cancelRun,
  createRun: apiMocks.createRun,
  postRunAction: apiMocks.postRunAction,
  submitFeedback: apiMocks.submitFeedback,
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
    apiMocks.fetchPersonas.mockReset();
    apiMocks.fetchWorkspaces.mockReset();
    apiMocks.fetchRuns.mockReset();
    apiMocks.fetchMetrics.mockReset();
    apiMocks.fetchRunDetail.mockReset();
    apiMocks.fetchPersonas.mockResolvedValue([
      { id: 'p1', name: 'Persona 1', slug: 'p1' },
      { id: 'p2', name: 'Persona 2', slug: 'p2' },
    ]);
    apiMocks.fetchWorkspaces.mockResolvedValue([{ id: 'main', name: 'Main', slug: 'main' }]);
    apiMocks.fetchMetrics.mockResolvedValue(null);
    apiMocks.fetchRunDetail.mockResolvedValue(null);
  });

  it('ignores stale run list responses after persona switch', async () => {
    const p1Runs = createDeferred<MasterRun[]>();

    apiMocks.fetchRuns.mockImplementation((personaId: string) => {
      if (personaId === 'p1') return p1Runs.promise;
      return Promise.resolve([makeRun('run-p2', 'p2')]);
    });

    const { result } = renderHook(() => useMasterView());

    await waitFor(() => {
      expect(apiMocks.fetchRuns).toHaveBeenCalledWith('p1', 'main', expect.anything());
    });

    act(() => {
      result.current.setSelectedPersonaId('p2');
    });

    await waitFor(() => {
      expect(apiMocks.fetchRuns).toHaveBeenCalledWith('p2', 'main', expect.anything());
    });

    await waitFor(() => {
      expect(result.current.runs[0]?.id).toBe('run-p2');
    });

    p1Runs.resolve([makeRun('run-p1', 'p1')]);

    await waitFor(() => {
      expect(result.current.runs[0]?.id).toBe('run-p2');
    });
  });
});
