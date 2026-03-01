'use client';

/**
 * useMasterView – centralises all state and async logic for the Master page.
 *
 * Components only receive data and callbacks; no fetch calls in JSX.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MasterRun,
  MasterMetrics,
  MasterPersonaSummary,
  StatusMessage,
  ApprovalDecision,
  WorkspaceSummary,
} from '@/modules/master/types';
import {
  fetchPersonas,
  fetchWorkspaces,
  fetchRuns,
  fetchMetrics,
  fetchRunDetail,
  cancelRun as apiCancelRun,
  createRun as apiCreateRun,
  postRunAction,
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
  | 'refreshing'
  | null;

export interface UseMasterViewResult {
  // Data
  personas: MasterPersonaSummary[];
  workspaces: WorkspaceSummary[];
  runs: MasterRun[];
  paginatedRuns: MasterRun[];
  runsPage: number;
  totalRunPages: number;
  selectedRun: MasterRun | null;
  selectedRunDetail: RunDetail | null;
  metrics: MasterMetrics | null;
  exportBundle: { data: string; runId: string } | null;
  // UI state
  loading: boolean;
  loadingAction: LoadingAction;
  statusMessage: StatusMessage | null;
  hasActiveRuns: boolean;
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
  submitFeedback: (input: SubmitFeedbackInput) => Promise<void>;
  dismissExportBundle: () => void;
  refreshAll: () => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMasterView(): UseMasterViewResult {
  const [personas, setPersonas] = useState<MasterPersonaSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('main');
  const [runTitle, setRunTitle] = useState('New Master Contract');
  const [runContract, setRunContract] = useState('');
  const [runs, setRuns] = useState<MasterRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MasterMetrics | null>(null);
  const [loadingAction, setLoadingAction] = useState<LoadingAction>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [exportBundle, setExportBundle] = useState<{ data: string; runId: string } | null>(null);
  const [runsPage, setRunsPage] = useState(0);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);

  // Ref to avoid stale closure over selectedRunId in refreshAll
  const selectedRunIdRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);

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
    };
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const hasActiveRuns = useMemo(() => runs.some((r) => ACTIVE_RUN_STATUSES.has(r.status)), [runs]);
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

  const loadRuns = useCallback(async (personaId: string, workspace: string) => {
    const nextRuns = await fetchRuns(personaId, workspace);
    setRuns(nextRuns);
    setSelectedRunId((prev) => prev || nextRuns[0]?.id || null);
  }, []);

  const loadMetrics = useCallback(async (personaId: string, workspace: string) => {
    const nextMetrics = await fetchMetrics(personaId, workspace);
    setMetrics(nextMetrics);
  }, []);

  const refreshAll = useCallback(async () => {
    if (!selectedPersonaId || !workspaceId) return;
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoadingAction('refreshing');
    try {
      await Promise.all([
        loadRuns(selectedPersonaId, workspaceId),
        loadMetrics(selectedPersonaId, workspaceId),
      ]);
      // Refresh selected run detail (uses ref to avoid stale closure)
      const currentRunId = selectedRunIdRef.current;
      if (currentRunId) {
        const detail = await fetchRunDetail(currentRunId, selectedPersonaId, workspaceId);
        setSelectedRunDetail(detail);
      }
    } catch (error) {
      showStatus({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      refreshInFlightRef.current = false;
      setLoadingAction(null);
    }
  }, [loadMetrics, loadRuns, selectedPersonaId, workspaceId, showStatus]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const createRun = useCallback(async () => {
    if (!selectedPersonaId || !workspaceId) {
      showStatus({ tone: 'error', text: 'Select persona and workspace first.' });
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
        personaId: selectedPersonaId,
        workspaceId,
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
  }, [runContract, runTitle, selectedPersonaId, workspaceId, refreshAll, showStatus]);

  const startRun = useCallback(
    async (runId: string) => {
      // Optimistic update – show EXECUTING immediately
      setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, status: 'EXECUTING' } : r)));
      setLoadingAction('starting');
      try {
        await postRunAction(runId, {
          actionType: 'run.start',
          stepId: `run-start-${Date.now()}`,
          personaId: selectedPersonaId,
          workspaceId,
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
          personaId: selectedPersonaId,
          workspaceId,
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
        await apiCancelRun(runId, selectedPersonaId, workspaceId);
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

  const submitDecision = useCallback(
    async (actionType: string, decision: ApprovalDecision) => {
      if (!selectedRunId) {
        showStatus({ tone: 'error', text: 'Select a run first.' });
        return;
      }
      setLoadingAction('deciding');
      try {
        await postRunAction(selectedRunId, {
          actionType,
          decision,
          stepId: `approval-${Date.now()}`,
          personaId: selectedPersonaId,
          workspaceId,
        });
        showStatus({ tone: 'success', text: `Decision applied: ${decision} for ${actionType}.` });
        await refreshAll();
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoadingAction(null);
      }
    },
    [selectedRunId, refreshAll, selectedPersonaId, workspaceId, showStatus],
  );

  const submitFeedback = useCallback(
    async (input: SubmitFeedbackInput) => {
      setLoadingAction('submitting-feedback');
      try {
        await apiSubmitFeedback(input, selectedPersonaId, workspaceId);
        showStatus({ tone: 'success', text: 'Feedback submitted.' });
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoadingAction(null);
      }
    },
    [selectedPersonaId, workspaceId, showStatus],
  );

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([fetchPersonas(), fetchWorkspaces()])
      .then(([nextPersonas, nextWorkspaces]) => {
        setPersonas(nextPersonas);
        setWorkspaces(nextWorkspaces);
        if (!selectedPersonaId && nextPersonas.length > 0) {
          setSelectedPersonaId(nextPersonas[0].id);
        }
      })
      .catch((error: unknown) => {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial data load when persona or workspace changes.
  // Uses stable loadRuns/loadMetrics (both have [] deps) to avoid the
  // identity-change loop that refreshAll's setLoadingAction calls would cause.
  useEffect(() => {
    if (!selectedPersonaId || !workspaceId) return;
    void loadRuns(selectedPersonaId, workspaceId);
    void loadMetrics(selectedPersonaId, workspaceId);
  }, [selectedPersonaId, workspaceId, loadRuns, loadMetrics]);

  // Keep a stable ref to refreshAll so the polling interval never needs to
  // be recreated when refreshAll's identity changes.
  const refreshAllRef = useRef(refreshAll);
  useEffect(() => {
    refreshAllRef.current = refreshAll;
  });

  // Auto-poll only while there are truly transitioning runs (not AWAITING_APPROVAL
  // which blocks indefinitely on user input). Uses a ref-stable callback so the
  // timer is never cleared/restarted due to refreshAll identity changes.
  useEffect(() => {
    if (!selectedPersonaId || !workspaceId || !hasTransitioningRuns) return;
    const interval = setInterval(() => {
      void refreshAllRef.current();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasTransitioningRuns, selectedPersonaId, workspaceId]);

  // Load run detail when selectedRunId changes
  useEffect(() => {
    if (!selectedRunId || !selectedPersonaId || !workspaceId) {
      setSelectedRunDetail(null);
      return;
    }
    fetchRunDetail(selectedRunId, selectedPersonaId, workspaceId)
      .then((detail) => setSelectedRunDetail(detail))
      .catch(() => setSelectedRunDetail(null));
  }, [selectedRunId, selectedPersonaId, workspaceId]);

  return {
    personas,
    workspaces,
    runs,
    paginatedRuns,
    runsPage,
    totalRunPages,
    selectedRun,
    selectedRunDetail,
    metrics,
    exportBundle,
    loading,
    loadingAction,
    statusMessage,
    hasActiveRuns,
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
    submitFeedback,
    refreshAll,
  };
}
