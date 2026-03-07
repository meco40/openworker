import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterApprovalRequest, MasterRun } from '@/modules/master/types';
import { useMasterView } from '@/modules/master/hooks/useMasterView';

const apiMocks = vi.hoisted(() => ({
  fetchMasterSettings: vi.fn(),
  fetchMasterPersonas: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchRuns: vi.fn(),
  fetchMetrics: vi.fn(),
  fetchRunDetail: vi.fn(),
  fetchApprovalRequests: vi.fn(),
  fetchSubagentSessions: vi.fn(),
  fetchReminders: vi.fn(),
  cancelRun: vi.fn(async (): Promise<unknown> => ({})),
  createRun: vi.fn(),
  decideApprovalRequest: vi.fn(),
  createMasterEventsUrl: vi.fn(() => '/api/master/events?workspaceId=main&personaId=master-1'),
  parseMasterEventMessage: vi.fn((data: string) => JSON.parse(data)),
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
  fetchApprovalRequests: apiMocks.fetchApprovalRequests,
  fetchSubagentSessions: apiMocks.fetchSubagentSessions,
  fetchReminders: apiMocks.fetchReminders,
  cancelRun: apiMocks.cancelRun,
  createRun: apiMocks.createRun,
  decideApprovalRequest: apiMocks.decideApprovalRequest,
  createMasterEventsUrl: apiMocks.createMasterEventsUrl,
  isMasterSystemPersonaDisabledError: (error: unknown) =>
    error instanceof Error && /disabled/i.test(error.message),
  parseMasterEventMessage: apiMocks.parseMasterEventMessage,
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
    ownerId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
  };
}

function makeApproval(overrides: Partial<MasterApprovalRequest> = {}): MasterApprovalRequest {
  return {
    id: 'approval-1',
    runId: 'run-1',
    stepId: 'step-1',
    userId: 'u1',
    workspaceId: 'persona:master-1:main',
    toolName: 'gmail.send',
    actionType: 'gmail.send',
    summary: 'Approval required',
    prompt: 'Approval required for gmail.send',
    host: 'gateway',
    cwd: null,
    resolvedPath: null,
    fingerprint: 'mail:f1',
    riskLevel: 'high',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    decision: null,
    decisionReason: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
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

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(_url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const handlers = this.listeners.get(type) ?? new Set<(event: MessageEvent<string>) => void>();
    handlers.add(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener as (event: MessageEvent<string>) => void);
  }

  emit(type: string, event: MessageEvent<string>) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  close() {}
}

describe('useMasterView race guards', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    apiMocks.fetchMasterSettings.mockReset();
    apiMocks.fetchMasterPersonas.mockReset();
    apiMocks.fetchWorkspaces.mockReset();
    apiMocks.fetchRuns.mockReset();
    apiMocks.fetchMetrics.mockReset();
    apiMocks.fetchRunDetail.mockReset();
    apiMocks.fetchApprovalRequests.mockReset();
    apiMocks.fetchSubagentSessions.mockReset();
    apiMocks.fetchReminders.mockReset();
    apiMocks.cancelRun.mockReset();
    apiMocks.createRun.mockReset();
    apiMocks.postRunAction.mockReset();
    apiMocks.decideApprovalRequest.mockReset();
    apiMocks.saveMasterSettings.mockReset();
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
      toolPolicy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: [],
      },
      instructionFiles: {
        'SOUL.md': 'Master soul',
        'AGENTS.md': 'Master agents',
        'USER.md': 'Master user',
      },
    });
    apiMocks.fetchWorkspaces.mockResolvedValue([{ id: 'main', name: 'Main', slug: 'main' }]);
    apiMocks.fetchMetrics.mockResolvedValue(null);
    apiMocks.fetchRunDetail.mockResolvedValue(null);
    apiMocks.fetchApprovalRequests.mockResolvedValue([]);
    apiMocks.fetchSubagentSessions.mockResolvedValue([]);
    apiMocks.fetchReminders.mockResolvedValue([]);
    apiMocks.cancelRun.mockResolvedValue({});
    apiMocks.createRun.mockResolvedValue(makeRun('run-new', 'master-1'));
    apiMocks.postRunAction.mockResolvedValue({});
    apiMocks.decideApprovalRequest.mockResolvedValue({
      approval: makeApproval({ status: 'approved' }),
      run: { ...makeRun('run-1', 'master-1'), status: 'EXECUTING', pausedForApproval: false },
    });
    apiMocks.saveMasterSettings.mockResolvedValue({
      persona: {
        id: 'master-1',
        name: 'Master',
        slug: 'master',
        emoji: '🧭',
        systemPersonaKey: 'master',
      },
      runtimeSettings: {
        preferredModelId: 'gpt-4.1',
        modelHubProfileId: 'ops-team',
        isAutonomous: true,
        maxToolCalls: 240,
      },
      allowedToolFunctionNames: ['shell_execute', 'web_search'],
      toolPolicy: {
        security: 'allowlist',
        ask: 'on_miss',
        allowlist: [],
      },
      instructionFiles: {
        'SOUL.md': 'Master soul',
        'AGENTS.md': 'Master agents',
        'USER.md': 'Master user',
      },
    });
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
    apiMocks.fetchApprovalRequests.mockResolvedValue([]);
    apiMocks.fetchSubagentSessions.mockResolvedValue([]);
    apiMocks.fetchReminders.mockResolvedValue([]);

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

  it('refreshes only targeted slices when an updated event arrives', async () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    apiMocks.fetchRuns.mockResolvedValue([]);

    const { result } = renderHook(() => useMasterView());

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    act(() => {
      FakeEventSource.instances[0]?.onopen?.();
    });

    await waitFor(() => {
      expect(result.current.eventsConnected).toBe(true);
    });

    const initialRunCalls = apiMocks.fetchRuns.mock.calls.length;
    const initialMetricsCalls = apiMocks.fetchMetrics.mock.calls.length;
    const initialApprovalsCalls = apiMocks.fetchApprovalRequests.mock.calls.length;
    act(() => {
      const event = {
        data: JSON.stringify({
          id: 'evt-1',
          type: 'updated',
          at: new Date().toISOString(),
          resources: ['metrics'],
        }),
      } as MessageEvent<string>;
      FakeEventSource.instances[0]?.emit('updated', event);
      FakeEventSource.instances[0]?.onmessage?.(event);
    });

    await waitFor(() => {
      expect(apiMocks.fetchMetrics.mock.calls.length).toBeGreaterThan(initialMetricsCalls);
    });
    expect(apiMocks.fetchRuns.mock.calls.length).toBe(initialRunCalls);
    expect(apiMocks.fetchApprovalRequests.mock.calls.length).toBe(initialApprovalsCalls);

    vi.unstubAllGlobals();
  });

  it('keeps legacy snapshot events as full-refresh fallback', async () => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
    apiMocks.fetchRuns.mockResolvedValue([]);

    renderHook(() => useMasterView());

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    act(() => {
      FakeEventSource.instances[0]?.onopen?.();
    });

    const initialRunCalls = apiMocks.fetchRuns.mock.calls.length;
    act(() => {
      const event = {
        data: JSON.stringify({
          id: 'evt-legacy',
          type: 'snapshot',
          at: new Date().toISOString(),
          pendingApprovals: 0,
          activeRuns: 0,
        }),
      } as MessageEvent<string>;
      FakeEventSource.instances[0]?.emit('snapshot', event);
      FakeEventSource.instances[0]?.onmessage?.(event);
    });

    await waitFor(() => {
      expect(apiMocks.fetchRuns.mock.calls.length).toBeGreaterThan(initialRunCalls);
    });

    vi.unstubAllGlobals();
  });

  it('creates a run without triggering a full refresh fan-out', async () => {
    apiMocks.fetchRuns.mockResolvedValue([]);
    apiMocks.fetchRunDetail.mockResolvedValue({
      run: makeRun('run-new', 'master-1'),
      steps: [],
    });

    const { result } = renderHook(() => useMasterView());

    await waitFor(() => {
      expect(result.current.selectedPersonaId).toBe('master-1');
    });

    const runsBefore = apiMocks.fetchRuns.mock.calls.length;
    const approvalsBefore = apiMocks.fetchApprovalRequests.mock.calls.length;
    const sessionsBefore = apiMocks.fetchSubagentSessions.mock.calls.length;
    const remindersBefore = apiMocks.fetchReminders.mock.calls.length;

    act(() => {
      result.current.setRunContract('Build a plan');
    });

    await act(async () => {
      await result.current.createRun();
    });

    await waitFor(() => {
      expect(result.current.runs.some((run) => run.id === 'run-new')).toBe(true);
      expect(result.current.selectedRunId).toBe('run-new');
    });

    expect(apiMocks.fetchRuns.mock.calls.length).toBe(runsBefore);
    expect(apiMocks.fetchApprovalRequests.mock.calls.length).toBe(approvalsBefore);
    expect(apiMocks.fetchSubagentSessions.mock.calls.length).toBe(sessionsBefore);
    expect(apiMocks.fetchReminders.mock.calls.length).toBe(remindersBefore);
  });

  it('starts and cancels runs without a full refresh fan-out', async () => {
    apiMocks.fetchRuns.mockResolvedValue([makeRun('run-1', 'master-1')]);
    apiMocks.postRunAction
      .mockResolvedValueOnce({ run: { ...makeRun('run-1', 'master-1'), status: 'EXECUTING' } })
      .mockResolvedValueOnce({});
    apiMocks.cancelRun.mockResolvedValueOnce({
      run: { ...makeRun('run-1', 'master-1'), status: 'CANCELLED', pausedForApproval: false },
    });

    const { result } = renderHook(() => useMasterView());

    await waitFor(() => {
      expect(result.current.runs[0]?.id).toBe('run-1');
    });

    const approvalsBefore = apiMocks.fetchApprovalRequests.mock.calls.length;
    const sessionsBefore = apiMocks.fetchSubagentSessions.mock.calls.length;
    const remindersBefore = apiMocks.fetchReminders.mock.calls.length;

    await act(async () => {
      await result.current.startRun('run-1');
    });

    await waitFor(() => {
      expect(result.current.runs[0]?.status).toBe('EXECUTING');
    });

    await act(async () => {
      await result.current.cancelRun('run-1');
    });

    await waitFor(() => {
      expect(result.current.runs[0]?.status).toBe('CANCELLED');
    });

    expect(apiMocks.fetchApprovalRequests.mock.calls.length).toBe(approvalsBefore);
    expect(apiMocks.fetchSubagentSessions.mock.calls.length).toBe(sessionsBefore);
    expect(apiMocks.fetchReminders.mock.calls.length).toBe(remindersBefore);
  });

  it('applies approval decisions locally without a full refresh fan-out', async () => {
    apiMocks.fetchRuns.mockResolvedValue([
      { ...makeRun('run-1', 'master-1'), status: 'AWAITING_APPROVAL', pausedForApproval: true },
    ]);
    apiMocks.fetchApprovalRequests.mockResolvedValue([makeApproval()]);
    apiMocks.decideApprovalRequest.mockResolvedValue({
      approval: makeApproval({ status: 'approved', decision: 'approve_once' }),
      run: { ...makeRun('run-1', 'master-1'), status: 'EXECUTING', pausedForApproval: false },
    });

    const { result } = renderHook(() => useMasterView());

    await waitFor(() => {
      expect(result.current.approvalRequests[0]?.status).toBe('pending');
    });

    const approvalsBefore = apiMocks.fetchApprovalRequests.mock.calls.length;
    const runsBefore = apiMocks.fetchRuns.mock.calls.length;

    await act(async () => {
      await result.current.decideApproval('approval-1', 'approve_once');
    });

    await waitFor(() => {
      expect(result.current.approvalRequests[0]?.status).toBe('approved');
      expect(result.current.runs[0]?.status).toBe('EXECUTING');
    });

    expect(apiMocks.fetchApprovalRequests.mock.calls.length).toBe(approvalsBefore);
    expect(apiMocks.fetchRuns.mock.calls.length).toBe(runsBefore);
  });

  it('saves settings without triggering a full refresh fan-out', async () => {
    apiMocks.fetchRuns.mockResolvedValue([]);

    const { result } = renderHook(() => useMasterView());

    await waitFor(() => {
      expect(result.current.masterSettings?.runtimeSettings.maxToolCalls).toBe(120);
    });

    const runsBefore = apiMocks.fetchRuns.mock.calls.length;
    const approvalsBefore = apiMocks.fetchApprovalRequests.mock.calls.length;
    const sessionsBefore = apiMocks.fetchSubagentSessions.mock.calls.length;

    await act(async () => {
      await result.current.saveSettings({ maxToolCalls: 240 });
    });

    await waitFor(() => {
      expect(result.current.masterSettings?.runtimeSettings.maxToolCalls).toBe(240);
    });

    expect(apiMocks.fetchRuns.mock.calls.length).toBe(runsBefore);
    expect(apiMocks.fetchApprovalRequests.mock.calls.length).toBe(approvalsBefore);
    expect(apiMocks.fetchSubagentSessions.mock.calls.length).toBe(sessionsBefore);
  });
});
