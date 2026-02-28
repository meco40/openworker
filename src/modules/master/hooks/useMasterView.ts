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
} from '@/modules/master/types';
import {
  fetchPersonas,
  fetchRuns,
  fetchMetrics,
  fetchRunDetail,
  cancelRun as apiCancelRun,
  createRun as apiCreateRun,
  postRunAction,
  type RunDetail,
} from '@/modules/master/api';

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

const RUNS_PER_PAGE = 10;
const AUTO_REFRESH_INTERVAL_MS = 5_000;
const STATUS_DISMISS_DELAY_MS = 5_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UseMasterViewResult {
  // Data
  personas: MasterPersonaSummary[];
  runs: MasterRun[];
  paginatedRuns: MasterRun[];
  runsPage: number;
  totalRunPages: number;
  selectedRun: MasterRun | null;
  selectedRunDetail: RunDetail | null;
  metrics: MasterMetrics | null;
  exportBundle: string | null;
  // UI state
  loading: boolean;
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
  refreshAll: () => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMasterView(): UseMasterViewResult {
  const [personas, setPersonas] = useState<MasterPersonaSummary[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('main');
  const [runTitle, setRunTitle] = useState('New Master Contract');
  const [runContract, setRunContract] = useState('');
  const [runs, setRuns] = useState<MasterRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MasterMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [exportBundle, setExportBundle] = useState<string | null>(null);
  const [runsPage, setRunsPage] = useState(0);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);
  const refreshInFlightRef = useRef(false);

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
    setLoading(true);
    try {
      await Promise.all([
        loadRuns(selectedPersonaId, workspaceId),
        loadMetrics(selectedPersonaId, workspaceId),
      ]);
    } catch (error) {
      showStatus({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      refreshInFlightRef.current = false;
      setLoading(false);
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
    setLoading(true);
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
      setLoading(false);
    }
  }, [runContract, runTitle, selectedPersonaId, workspaceId, refreshAll, showStatus]);

  const startRun = useCallback(
    async (runId: string) => {
      setLoading(true);
      try {
        await postRunAction(runId, {
          actionType: 'run.start',
          stepId: `run-start-${Date.now()}`,
          personaId: selectedPersonaId,
          workspaceId,
        });
        showStatus({ tone: 'info', text: 'Run started in background.' });
        await refreshAll();
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoading(false);
      }
    },
    [refreshAll, selectedPersonaId, workspaceId, showStatus],
  );

  const exportRun = useCallback(
    async (runId: string) => {
      setLoading(true);
      try {
        const result = await postRunAction(runId, {
          actionType: 'run.export',
          stepId: `run-export-${Date.now()}`,
          personaId: selectedPersonaId,
          workspaceId,
        });
        setExportBundle(JSON.stringify(result.exportBundle ?? {}, null, 2));
        showStatus({ tone: 'success', text: 'Result bundle exported.' });
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoading(false);
      }
    },
    [selectedPersonaId, workspaceId, showStatus],
  );

  const cancelRun = useCallback(
    async (runId: string) => {
      setLoading(true);
      try {
        await apiCancelRun(runId, selectedPersonaId, workspaceId);
        showStatus({ tone: 'info', text: 'Run cancelled.' });
        await refreshAll();
      } catch (error) {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoading(false);
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
      setLoading(true);
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
        setLoading(false);
      }
    },
    [selectedRunId, refreshAll, selectedPersonaId, workspaceId, showStatus],
  );

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchPersonas()
      .then((nextPersonas) => {
        setPersonas(nextPersonas);
        if (!selectedPersonaId && nextPersonas.length > 0) {
          setSelectedPersonaId(nextPersonas[0].id);
        }
      })
      .catch((error: unknown) => {
        showStatus({ tone: 'error', text: toErrorMessage(error) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedPersonaId || !workspaceId) return;
    void refreshAll();
  }, [refreshAll, selectedPersonaId, workspaceId]);

  useEffect(() => {
    if (!selectedPersonaId || !workspaceId || !hasActiveRuns) return;
    const interval = setInterval(() => {
      void refreshAll();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasActiveRuns, refreshAll, selectedPersonaId, workspaceId]);

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
    runs,
    paginatedRuns,
    runsPage,
    totalRunPages,
    selectedRun,
    selectedRunDetail,
    metrics,
    exportBundle,
    loading,
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
    createRun,
    startRun,
    exportRun,
    cancelRun,
    submitDecision,
    refreshAll,
  };
}
