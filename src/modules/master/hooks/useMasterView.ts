'use client';

/**
 * useMasterView – centralises all state and async logic for the Master page.
 *
 * Components only receive data and callbacks; no fetch calls in JSX.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MasterViewMode,
  MasterRun,
  MasterMetrics,
  MasterPersonaSummary,
  MasterSettingsSnapshot,
  MasterApprovalRequest,
  MasterSubagentSession,
  MasterReminder,
  SaveMasterSettingsInput,
  StatusMessage,
  ApprovalDecision,
  WorkspaceSummary,
} from '@/modules/master/types';
import {
  createMasterEventsUrl,
  decideApprovalRequest,
  fetchApprovalRequests,
  fetchMasterPersonas,
  fetchMasterSettings,
  fetchReminders,
  fetchSubagentSessions,
  fetchWorkspaces,
  fetchRuns,
  fetchMetrics,
  fetchRunDetail,
  cancelRun as apiCancelRun,
  createRun as apiCreateRun,
  isMasterSystemPersonaDisabledError,
  parseMasterEventMessage,
  postRunAction,
  saveMasterSettings as apiSaveMasterSettings,
  submitFeedback as apiSubmitFeedback,
  type RunDetail,
  type SubmitFeedbackInput,
} from '@/modules/master/api';
import { toErrorMessage } from '@/shared/lib/errors';

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTIVE_RUN_STATUSES = new Set([
  'ANALYZING',
  'PLANNING',
  'DELEGATING',
  'EXECUTING',
  'VERIFYING',
  'REFINING',
  'AWAITING_APPROVAL',
]);

// Statuses that are truly transitioning (exclude AWAITING_APPROVAL which
// blocks indefinitely on user input and does not need background polling).
const TRANSITIONING_RUN_STATUSES = new Set([
  'ANALYZING',
  'PLANNING',
  'DELEGATING',
  'EXECUTING',
  'VERIFYING',
  'REFINING',
]);

const RUNS_PER_PAGE = 10;
const AUTO_REFRESH_INTERVAL_MS = 5_000;
const STATUS_DISMISS_DELAY_MS = 5_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type LoadingAction =
  | 'creating'
  | 'starting'
  | 'exporting'
  | 'cancelling'
  | 'deciding'
  | 'submitting-feedback'
  | 'saving-settings'
  | 'refreshing'
  | null;

export type SubmitFeedbackResult = { ok: true } | { ok: false; error: string };

export interface UseMasterViewResult {
  // Data
  masterMode: MasterViewMode;
  masterPersona: MasterPersonaSummary | null;
  masterSettings: MasterSettingsSnapshot | null;
  availablePersonas: MasterPersonaSummary[];
  workspaces: WorkspaceSummary[];
  runs: MasterRun[];
  approvalRequests: MasterApprovalRequest[];
  subagentSessions: MasterSubagentSession[];
  reminders: MasterReminder[];
  paginatedRuns: MasterRun[];
  runsPage: number;
  totalRunPages: number;
  selectedRun: MasterRun | null;
  selectedRunDetail: RunDetail | null;
  metrics: MasterMetrics | null;
  exportBundle: { data: string; runId: string } | null;
  eventsConnected: boolean;
  // UI state
  loading: boolean;
  loadingAction: LoadingAction;
  statusMessage: StatusMessage | null;
  hasActiveRuns: boolean;
  hasPendingApprovals: boolean;
  // Form state
  selectedPersonaId: string;
  workspaceId: string;
  runTitle: string;
  runContract: string;
  selectedRunId: string | null;
  // Actions
  setSelectedPersonaId: (id: string) => void;
  setWorkspaceId: (id: string) => void;
  setRunTitle: (title: string) => void;
  setRunContract: (contract: string) => void;
  setSelectedRunId: (id: string | null) => void;
  setRunsPage: (page: number) => void;
  dismissStatus: () => void;
  createRun: () => Promise<void>;
  startRun: (runId: string) => Promise<void>;
  exportRun: (runId: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  submitDecision: (actionType: string, decision: ApprovalDecision) => Promise<void>;
  decideApproval: (approvalRequestId: string, decision: ApprovalDecision) => Promise<void>;
  submitFeedback: (input: SubmitFeedbackInput) => Promise<SubmitFeedbackResult>;
  saveSettings: (input: SaveMasterSettingsInput) => Promise<void>;
  dismissExportBundle: () => void;
  refreshAll: () => Promise<void>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMasterView(): UseMasterViewResult {
  const [masterMode, setMasterMode] = useState<MasterViewMode>('system');
  const [masterPersona, setMasterPersona] = useState<MasterPersonaSummary | null>(null);
  const [masterSettings, setMasterSettings] = useState<MasterSettingsSnapshot | null>(null);
  const [availablePersonas, setAvailablePersonas] = useState<MasterPersonaSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('main');
  const [runTitle, setRunTitle] = useState('New Master Contract');
  const [runContract, setRunContract] = useState('');
  const [runs, setRuns] = useState<MasterRun[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<MasterApprovalRequest[]>([]);
  const [subagentSessions, setSubagentSessions] = useState<MasterSubagentSession[]>([]);
  const [reminders, setReminders] = useState<MasterReminder[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MasterMetrics | null>(null);
  const [loadingAction, setLoadingAction] = useState<LoadingAction>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [exportBundle, setExportBundle] = useState<{ data: string; runId: string } | null>(null);
  const [runsPage, setRunsPage] = useState(0);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);
  const [eventsConnected, setEventsConnected] = useState(false);

  // Ref to avoid stale closure over selectedRunId in refreshAll
  const selectedRunIdRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const scopeTokenRef = useRef(0);
  const runsAbortRef = useRef<AbortController | null>(null);
  const metricsAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const approvalsAbortRef = useRef<AbortController | null>(null);
  const sessionsAbortRef = useRef<AbortController | null>(null);
  const remindersAbortRef = useRef<AbortController | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  // Derived boolean for convenience
  const loading = loadingAction !== null;

  // Auto-dismiss status message after 5s
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showStatus = useCallback((msg: StatusMessage) => {
    setStatusMessage(msg);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => setStatusMessage(null), STATUS_DISMISS_DELAY_MS);
  }, []);

  const dismissStatus = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setStatusMessage(null);
  }, []);

  const dismissExportBundle = useCallback(() => {
    setExportBundle(null);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      runsAbortRef.current?.abort();
      metricsAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      approvalsAbortRef.current?.abort();
      sessionsAbortRef.current?.abort();
      remindersAbortRef.current?.abort();
    };
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const hasActiveRuns = useMemo(() => runs.some((r) => ACTIVE_RUN_STATUSES.has(r.status)), [runs]);
  const hasPendingApprovals = useMemo(
    () => approvalRequests.some((request) => request.status === 'pending'),
    [approvalRequests],
  );
  const hasTransitioningRuns = useMemo(
    () => runs.some((r) => TRANSITIONING_RUN_STATUSES.has(r.status)),
    [runs],
  );

  const totalRunPages = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));

  const paginatedRuns = useMemo(
    () => runs.slice(runsPage * RUNS_PER_PAGE, (runsPage + 1) * RUNS_PER_PAGE),
    [runs, runsPage],
  );

  // ── Data loading ───────────────────────────────────────────────────────────

  const loadRuns = useCallback(async (personaId: string, workspace: string, scopeToken: number) => {
    runsAbortRef.current?.abort();
    const controller = new AbortController();
    runsAbortRef.current = controller;
    try {
      const nextRuns = await fetchRuns(workspace, personaId, controller.signal);
      if (scopeToken !== scopeTokenRef.current) return;
      setRuns(nextRuns);
      setSelectedRunId((prev) => {
        if (prev && nextRuns.some((run) => run.id === prev)) return prev;
        return nextRuns[0]?.id || null;
      });
    } finally {
      if (runsAbortRef.current === controller) {
        runsAbortRef.current = null;
      }
    }
  }, []);

  const loadMetrics = useCallback(
    async (personaId: string, workspace: string, scopeToken: number) => {
      metricsAbortRef.current?.abort();
      const controller = new AbortController();
      metricsAbortRef.current = controller;
      try {
        const nextMetrics = await fetchMetrics(workspace, personaId, controller.signal);
        if (scopeToken !== scopeTokenRef.current) return;
        setMetrics(nextMetrics);
      } finally {
        if (metricsAbortRef.current === controller) {
          metricsAbortRef.current = null;
        }
      }
    },
    [],
  );

  const loadApprovalRequests = useCallback(
    async (personaId: string, workspace: string, scopeToken: number) => {
      approvalsAbortRef.current?.abort();
      const controller = new AbortController();
      approvalsAbortRef.current = controller;
      try {
        const nextApprovals = await fetchApprovalRequests(workspace, personaId);
        if (scopeToken !== scopeTokenRef.current) return;
        setApprovalRequests(nextApprovals);
      } finally {
        if (approvalsAbortRef.current === controller) {
          approvalsAbortRef.current = null;
        }
      }
    },
    [],
  );

  const loadSubagentSessions = useCallback(
    async (personaId: string, workspace: string, scopeToken: number) => {
      sessionsAbortRef.current?.abort();
      const controller = new AbortController();
      sessionsAbortRef.current = controller;
      try {
        const nextSessions = await fetchSubagentSessions(workspace, personaId);
        if (scopeToken !== scopeTokenRef.current) return;
        setSubagentSessions(nextSessions);
      } finally {
        if (sessionsAbortRef.current === controller) {
          sessionsAbortRef.current = null;
        }
      }
    },
    [],
  );

  const loadReminders = useCallback(
    async (personaId: string, workspace: string, scopeToken: number) => {
      remindersAbortRef.current?.abort();
      const controller = new AbortController();
      remindersAbortRef.current = controller;
      try {
        const nextReminders = await fetchReminders(workspace, personaId);
        if (scopeToken !== scopeTokenRef.current) return;
        setReminders(nextReminders);
      } finally {
        if (remindersAbortRef.current === controller) {
          remindersAbortRef.current = null;
        }
      }
    },
    [],
  );

  const loadRunDetail = useCallback(
    async (runId: string, personaId: string, workspace: string, scopeToken: number) => {
      detailAbortRef.current?.abort();
      const controller = new AbortController();
      detailAbortRef.current = controller;
      try {
        const detail = await fetchRunDetail(runId, workspace, personaId, controller.signal);
        if (scopeToken !== scopeTokenRef.current) return;
        if (selectedRunIdRef.current !== runId) return;
        setSelectedRunDetail(detail);
      } finally {
        if (detailAbortRef.current === controller) {
          detailAbortRef.current = null;
        }
      }
    },
    [],
  );

  const refreshAll = useCallback(async () => {
    if (!selectedPersonaId || !workspaceId) return;
    if (refreshInFlightRef.current) return;
    const scopeToken = scopeTokenRef.current;
    refreshInFlightRef.current = true;
    setLoadingAction('refreshing');
    try {
      await Promise.all([
        loadRuns(selectedPersonaId, workspaceId, scopeToken),
        loadMetrics(selectedPersonaId, workspaceId, scopeToken),
        loadApprovalRequests(selectedPersonaId, workspaceId, scopeToken),
        loadSubagentSessions(selectedPersonaId, workspaceId, scopeToken),
        loadReminders(selectedPersonaId, workspaceId, scopeToken),
      ]);
      // Refresh selected run detail (uses ref to avoid stale closure)
      const currentRunId = selectedRunIdRef.current;
      if (currentRunId) {
        await loadRunDetail(currentRunId, selectedPersonaId, workspaceId, scopeToken);
      }
    } catch (error) {
      if (!isAbortError(error)) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      }
    } finally {
      refreshInFlightRef.current = false;
      setLoadingAction(null);
    }
  }, [
    loadApprovalRequests,
    loadMetrics,
    loadReminders,
    loadRunDetail,
    loadRuns,
    loadSubagentSessions,
    selectedPersonaId,
    workspaceId,
    showStatus,
  ]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const createRun = useCallback(async () => {
    if (!selectedPersonaId || !workspaceId) {
      showStatus({ tone: 'error', text: 'Master persona settings are still loading.' });
      return;
    }
    if (!runContract.trim()) {
      showStatus({ tone: 'error', text: 'Contract is required.' });
      return;
    }
    setLoadingAction('creating');
    try {
      const run = await apiCreateRun({
        title: runTitle.trim() || 'Master Contract',
        contract: runContract.trim(),
        workspaceId,
        personaId: selectedPersonaId,
      });
      showStatus({ tone: 'success', text: 'Master run created.' });
      setRunContract('');
      setSelectedRunId(run.id);
      await refreshAll();
    } catch (error) {
      showStatus({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setLoadingAction(null);
    }
  }, [selectedPersonaId, runContract, runTitle, workspaceId, refreshAll, showStatus]);

  const startRun = useCallback(
    async (runId: string) => {
      // Optimistic update – show EXECUTING immediately
      setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, status: 'EXECUTING' } : r)));
      setLoadingAction('starting');
      try {
        await postRunAction(runId, {
          actionType: 'run.start',
          stepId: `run-start-${Date.now()}`,
          workspaceId,
          personaId: selectedPersonaId,
        });
        showStatus({ tone: 'success', text: 'Run started in background.' });
        await refreshAll();
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
        // Revert optimistic update on failure
        await refreshAll();
      } finally {
        setLoadingAction(null);
      }
    },
    [refreshAll, selectedPersonaId, workspaceId, showStatus],
  );

  const exportRun = useCallback(
    async (runId: string) => {
      setLoadingAction('exporting');
      try {
        const result = await postRunAction(runId, {
          actionType: 'run.export',
          stepId: `run-export-${Date.now()}`,
          workspaceId,
          personaId: selectedPersonaId,
        });
        setExportBundle({
          data: JSON.stringify(result.exportBundle ?? {}, null, 2),
          runId,
        });
        showStatus({ tone: 'success', text: 'Result bundle exported.' });
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoadingAction(null);
      }
    },
    [selectedPersonaId, workspaceId, showStatus],
  );

  const cancelRun = useCallback(
    async (runId: string) => {
      // Optimistic update – show CANCELLED immediately
      setRuns((prev) =>
        prev.map((r) =>
          r.id === runId ? { ...r, status: 'CANCELLED', pausedForApproval: false } : r,
        ),
      );
      setLoadingAction('cancelling');
      try {
        await apiCancelRun(runId, workspaceId, selectedPersonaId);
        showStatus({ tone: 'info', text: 'Run cancelled.' });
        await refreshAll();
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
        // Revert optimistic update on failure
        await refreshAll();
      } finally {
        setLoadingAction(null);
      }
    },
    [refreshAll, selectedPersonaId, workspaceId, showStatus],
  );

  const decideApproval = useCallback(
    async (approvalRequestId: string, decision: ApprovalDecision) => {
      setLoadingAction('deciding');
      try {
        await decideApprovalRequest({
          approvalRequestId,
          decision,
          workspaceId,
          personaId: selectedPersonaId,
        });
        showStatus({ tone: 'success', text: `Decision applied: ${decision}.` });
        await refreshAll();
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoadingAction(null);
      }
    },
    [refreshAll, selectedPersonaId, workspaceId, showStatus],
  );

  const submitDecision = useCallback(
    async (actionType: string, decision: ApprovalDecision) => {
      const pendingRequest = approvalRequests.find(
        (request) =>
          request.status === 'pending' &&
          request.runId === selectedRunId &&
          request.actionType === actionType,
      );
      if (!pendingRequest) {
        showStatus({ tone: 'error', text: 'No matching approval request found.' });
        return;
      }
      await decideApproval(pendingRequest.id, decision);
    },
    [approvalRequests, decideApproval, selectedRunId, showStatus],
  );

  const submitFeedback = useCallback(
    async (input: SubmitFeedbackInput) => {
      setLoadingAction('submitting-feedback');
      try {
        await apiSubmitFeedback(input, workspaceId, selectedPersonaId);
        showStatus({ tone: 'success', text: 'Feedback submitted.' });
        return { ok: true } as const;
      } catch (error) {
        const message = toErrorMessage(error);
        showStatus({ tone: 'error', text: message });
        return { ok: false, error: message } as const;
      } finally {
        setLoadingAction(null);
      }
    },
    [selectedPersonaId, workspaceId, showStatus],
  );

  const saveSettings = useCallback(
    async (input: SaveMasterSettingsInput) => {
      if (masterMode !== 'system') {
        showStatus({ tone: 'error', text: 'Master settings are unavailable in legacy mode.' });
        return;
      }
      setLoadingAction('saving-settings');
      try {
        const snapshot = await apiSaveMasterSettings(input);
        setMasterSettings(snapshot);
        setMasterPersona(snapshot.persona);
        showStatus({ tone: 'success', text: 'Master settings saved.' });
        await refreshAll();
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoadingAction(null);
      }
    },
    [masterMode, refreshAll, showStatus],
  );

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    const loadInitialState = async () => {
      try {
        const [nextSettings, nextWorkspaces] = await Promise.all([
          fetchMasterSettings(),
          fetchWorkspaces(),
        ]);
        setMasterMode('system');
        setMasterSettings(nextSettings);
        setAvailablePersonas([nextSettings.persona]);
        setMasterPersona(nextSettings.persona);
        setSelectedPersonaId(nextSettings.persona.id);
        setWorkspaces(nextWorkspaces);
      } catch (error) {
        if (!isMasterSystemPersonaDisabledError(error)) {
          showStatus({ tone: 'error', text: toErrorMessage(error) });
          return;
        }
        try {
          const [legacyPersonas, nextWorkspaces] = await Promise.all([
            fetchMasterPersonas(),
            fetchWorkspaces(),
          ]);
          const initialPersona = legacyPersonas[0] ?? null;
          setMasterMode('legacy');
          setMasterSettings(null);
          setAvailablePersonas(legacyPersonas);
          setMasterPersona(initialPersona);
          setSelectedPersonaId(initialPersona?.id ?? '');
          setWorkspaces(nextWorkspaces);
        } catch (legacyError) {
          showStatus({ tone: 'error', text: toErrorMessage(legacyError) });
        }
      }
    };

    void loadInitialState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (masterMode !== 'legacy') {
      return;
    }
    const nextPersona =
      availablePersonas.find((persona) => persona.id === selectedPersonaId) ??
      availablePersonas[0] ??
      null;
    setMasterPersona(nextPersona);
    if ((nextPersona?.id ?? '') !== selectedPersonaId) {
      setSelectedPersonaId(nextPersona?.id ?? '');
    }
  }, [availablePersonas, masterMode, selectedPersonaId]);

  // Initial data load when persona or workspace changes.
  // Uses stable loadRuns/loadMetrics (both have [] deps) to avoid the
  // identity-change loop that refreshAll's setLoadingAction calls would cause.
  useEffect(() => {
    if (!selectedPersonaId || !workspaceId) return;
    const scopeToken = scopeTokenRef.current + 1;
    scopeTokenRef.current = scopeToken;
    setSelectedRunId(null);
    setSelectedRunDetail(null);
    detailAbortRef.current?.abort();

    void loadRuns(selectedPersonaId, workspaceId, scopeToken).catch((error: unknown) => {
      if (!isAbortError(error)) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      }
    });
    void loadMetrics(selectedPersonaId, workspaceId, scopeToken).catch((error: unknown) => {
      if (!isAbortError(error)) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      }
    });
    void loadApprovalRequests(selectedPersonaId, workspaceId, scopeToken).catch(
      (error: unknown) => {
        if (!isAbortError(error)) {
          showStatus({ tone: 'error', text: toErrorMessage(error) });
        }
      },
    );
    void loadSubagentSessions(selectedPersonaId, workspaceId, scopeToken).catch(
      (error: unknown) => {
        if (!isAbortError(error)) {
          showStatus({ tone: 'error', text: toErrorMessage(error) });
        }
      },
    );
    void loadReminders(selectedPersonaId, workspaceId, scopeToken).catch((error: unknown) => {
      if (!isAbortError(error)) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      }
    });
  }, [
    selectedPersonaId,
    workspaceId,
    loadApprovalRequests,
    loadMetrics,
    loadReminders,
    loadRuns,
    loadSubagentSessions,
    showStatus,
  ]);

  // Keep a stable ref to refreshAll so the polling interval never needs to
  // be recreated when refreshAll's identity changes.
  const refreshAllRef = useRef(refreshAll);
  useEffect(() => {
    refreshAllRef.current = refreshAll;
  });

  useEffect(() => {
    if (!selectedPersonaId || !workspaceId || typeof EventSource === 'undefined') {
      setEventsConnected(false);
      return;
    }
    const eventSource = new EventSource(createMasterEventsUrl(workspaceId, selectedPersonaId));
    const handleSnapshot = (event: MessageEvent<string>) => {
      if (!parseMasterEventMessage(event.data)) {
        return;
      }
      void refreshAllRef.current();
    };
    eventSource.onopen = () => {
      setEventsConnected(true);
    };
    eventSource.onmessage = handleSnapshot;
    eventSource.addEventListener('snapshot', handleSnapshot as EventListener);
    eventSource.onerror = () => {
      setEventsConnected(false);
      eventSource.close();
    };
    return () => {
      setEventsConnected(false);
      eventSource.removeEventListener('snapshot', handleSnapshot as EventListener);
      eventSource.close();
    };
  }, [selectedPersonaId, workspaceId]);

  // Auto-poll only while there are truly transitioning runs (not AWAITING_APPROVAL
  // which blocks indefinitely on user input). Uses a ref-stable callback so the
  // timer is never cleared/restarted due to refreshAll identity changes.
  useEffect(() => {
    if (!selectedPersonaId || !workspaceId || eventsConnected) return;
    if (!hasTransitioningRuns && !hasPendingApprovals) return;
    const interval = setInterval(() => {
      void refreshAllRef.current();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [eventsConnected, hasPendingApprovals, hasTransitioningRuns, selectedPersonaId, workspaceId]);

  // Load run detail when selectedRunId changes
  useEffect(() => {
    if (!selectedRunId || !selectedPersonaId || !workspaceId) {
      detailAbortRef.current?.abort();
      setSelectedRunDetail(null);
      return;
    }
    const scopeToken = scopeTokenRef.current;
    void loadRunDetail(selectedRunId, selectedPersonaId, workspaceId, scopeToken).catch(
      (error: unknown) => {
        if (!isAbortError(error)) {
          setSelectedRunDetail(null);
        }
      },
    );
  }, [selectedPersonaId, selectedRunId, workspaceId, loadRunDetail]);

  return {
    masterMode,
    masterPersona,
    masterSettings,
    availablePersonas,
    workspaces,
    runs,
    approvalRequests,
    subagentSessions,
    reminders,
    paginatedRuns,
    runsPage,
    totalRunPages,
    selectedRun,
    selectedRunDetail,
    metrics,
    exportBundle,
    eventsConnected,
    loading,
    loadingAction,
    statusMessage,
    hasActiveRuns,
    hasPendingApprovals,
    selectedPersonaId,
    workspaceId,
    runTitle,
    runContract,
    selectedRunId,
    setSelectedPersonaId,
    setWorkspaceId,
    setRunTitle,
    setRunContract,
    setSelectedRunId,
    setRunsPage,
    dismissStatus,
    dismissExportBundle,
    createRun,
    startRun,
    exportRun,
    cancelRun,
    submitDecision,
    decideApproval,
    submitFeedback,
    saveSettings,
    refreshAll,
  };
}
