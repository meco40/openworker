'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import MasterLearningPanel from '@/modules/master/components/MasterLearningPanel';

type MasterRunStatus =
  | 'IDLE'
  | 'ANALYZING'
  | 'PLANNING'
  | 'DELEGATING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'REFINING'
  | 'AWAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED';

interface PersonaSummary {
  id: string;
  name: string;
  slug: string;
}

interface MasterRun {
  id: string;
  title: string;
  contract: string;
  status: MasterRunStatus;
  progress: number;
  resultBundle: string | null;
  verificationPassed: boolean;
  pausedForApproval: boolean;
  lastError: string | null;
  updatedAt: string;
}

interface MasterMetrics {
  run_completion_rate?: number;
  verify_pass_rate?: number;
  delegation_success_rate?: number;
  generated_at?: string;
  [key: string]: unknown;
}

interface StatusMessage {
  tone: 'info' | 'success' | 'error';
  text: string;
}

const ACTIVE_RUN_STATUSES: MasterRunStatus[] = [
  'ANALYZING',
  'PLANNING',
  'DELEGATING',
  'EXECUTING',
  'VERIFYING',
  'REFINING',
  'AWAITING_APPROVAL',
];

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const MasterView: React.FC = () => {
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('main');
  const [runTitle, setRunTitle] = useState('New Master Contract');
  const [runContract, setRunContract] = useState('');
  const [runs, setRuns] = useState<MasterRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MasterMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [actionType, setActionType] = useState('gmail.send');
  const [decision, setDecision] = useState<'approve_once' | 'approve_always' | 'deny'>(
    'approve_once',
  );
  const [exportBundle, setExportBundle] = useState<string | null>(null);

  const selectedRun = useMemo(
    () => runs.find((entry) => entry.id === selectedRunId) || null,
    [runs, selectedRunId],
  );
  const hasActiveRuns = useMemo(
    () => runs.some((entry) => ACTIVE_RUN_STATUSES.includes(entry.status)),
    [runs],
  );

  const withScopeQuery = useCallback(
    (basePath: string) => {
      const params = new URLSearchParams();
      if (selectedPersonaId) params.set('personaId', selectedPersonaId);
      if (workspaceId) params.set('workspaceId', workspaceId);
      return `${basePath}?${params.toString()}`;
    },
    [selectedPersonaId, workspaceId],
  );

  const loadPersonas = useCallback(async () => {
    const response = await fetch('/api/personas', { cache: 'no-store' });
    const payload = (await response.json()) as {
      ok: boolean;
      personas?: PersonaSummary[];
      error?: string;
    };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to load personas.');
    }
    const nextPersonas = payload.personas || [];
    setPersonas(nextPersonas);
    if (!selectedPersonaId && nextPersonas.length > 0) {
      setSelectedPersonaId(nextPersonas[0].id);
    }
  }, [selectedPersonaId]);

  const loadRuns = useCallback(async () => {
    if (!selectedPersonaId || !workspaceId) return;
    const response = await fetch(withScopeQuery('/api/master/runs'), { cache: 'no-store' });
    const payload = (await response.json()) as { ok: boolean; runs?: MasterRun[]; error?: string };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to load runs.');
    }
    setRuns(payload.runs || []);
    if (!selectedRunId && payload.runs && payload.runs.length > 0) {
      setSelectedRunId(payload.runs[0].id);
    }
  }, [selectedPersonaId, workspaceId, withScopeQuery, selectedRunId]);

  const loadMetrics = useCallback(async () => {
    if (!selectedPersonaId || !workspaceId) return;
    const response = await fetch(withScopeQuery('/api/master/metrics'), { cache: 'no-store' });
    const payload = (await response.json()) as {
      ok: boolean;
      metrics?: MasterMetrics;
      error?: string;
    };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to load metrics.');
    }
    setMetrics(payload.metrics || null);
  }, [selectedPersonaId, workspaceId, withScopeQuery]);

  const refreshAll = useCallback(async () => {
    if (!selectedPersonaId || !workspaceId) return;
    setLoading(true);
    try {
      await Promise.all([loadRuns(), loadMetrics()]);
    } catch (error) {
      setStatusMessage({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [loadMetrics, loadRuns, selectedPersonaId, workspaceId]);

  const createRun = useCallback(async () => {
    if (!selectedPersonaId || !workspaceId) {
      setStatusMessage({ tone: 'error', text: 'Select persona and workspace first.' });
      return;
    }
    if (!runContract.trim()) {
      setStatusMessage({ tone: 'error', text: 'Contract is required.' });
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/master/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: runTitle.trim() || 'Master Contract',
          contract: runContract.trim(),
          personaId: selectedPersonaId,
          workspaceId,
        }),
      });
      const payload = (await response.json()) as { ok: boolean; run?: MasterRun; error?: string };
      if (!response.ok || !payload.ok || !payload.run) {
        throw new Error(payload.error || 'Failed to create run.');
      }
      setStatusMessage({ tone: 'success', text: 'Master run created.' });
      setRunContract('');
      setSelectedRunId(payload.run.id);
      await refreshAll();
    } catch (error) {
      setStatusMessage({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [runContract, runTitle, selectedPersonaId, workspaceId, refreshAll]);

  const postRunAction = useCallback(
    async (
      runId: string,
      payload: {
        actionType: string;
        stepId?: string;
        decision?: 'approve_once' | 'approve_always' | 'deny';
      },
    ) => {
      const response = await fetch(`/api/master/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          personaId: selectedPersonaId,
          workspaceId,
          stepId: payload.stepId || `step-${Date.now()}`,
          actionType: payload.actionType,
          decision: payload.decision,
        }),
      });
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        exportBundle?: unknown;
      };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Action failed: ${payload.actionType}`);
      }
      return data;
    },
    [selectedPersonaId, workspaceId],
  );

  const startRun = useCallback(
    async (runId: string) => {
      setLoading(true);
      try {
        await postRunAction(runId, {
          actionType: 'run.start',
          stepId: `run-start-${Date.now()}`,
        });
        setStatusMessage({ tone: 'info', text: 'Run started in background.' });
        await refreshAll();
      } catch (error) {
        setStatusMessage({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoading(false);
      }
    },
    [postRunAction, refreshAll],
  );

  const exportRun = useCallback(
    async (runId: string) => {
      setLoading(true);
      try {
        const payload = await postRunAction(runId, {
          actionType: 'run.export',
          stepId: `run-export-${Date.now()}`,
        });
        setExportBundle(JSON.stringify(payload.exportBundle || {}, null, 2));
        setStatusMessage({ tone: 'success', text: 'Result bundle exported.' });
      } catch (error) {
        setStatusMessage({ tone: 'error', text: toErrorMessage(error) });
      } finally {
        setLoading(false);
      }
    },
    [postRunAction],
  );

  const submitDecision = useCallback(async () => {
    if (!selectedRunId) {
      setStatusMessage({ tone: 'error', text: 'Select a run first.' });
      return;
    }
    setLoading(true);
    try {
      await postRunAction(selectedRunId, {
        actionType,
        decision,
        stepId: `approval-${Date.now()}`,
      });
      setStatusMessage({
        tone: 'success',
        text: `Decision applied: ${decision} for ${actionType}.`,
      });
      await refreshAll();
    } catch (error) {
      setStatusMessage({ tone: 'error', text: toErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [actionType, decision, postRunAction, refreshAll, selectedRunId]);

  useEffect(() => {
    void loadPersonas().catch((error: unknown) => {
      setStatusMessage({ tone: 'error', text: toErrorMessage(error) });
    });
  }, [loadPersonas]);

  useEffect(() => {
    if (!selectedPersonaId || !workspaceId) return;
    void refreshAll();
  }, [refreshAll, selectedPersonaId, workspaceId]);

  useEffect(() => {
    if (!selectedPersonaId || !workspaceId || !hasActiveRuns) return;
    const interval = setInterval(() => {
      void refreshAll();
    }, 5000);
    return () => clearInterval(interval);
  }, [hasActiveRuns, refreshAll, selectedPersonaId, workspaceId]);

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-lg font-semibold text-zinc-100">Master</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Create Master Run contracts, execute autonomously, review approvals, and export verified
          bundles.
        </p>
      </header>

      {statusMessage && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            statusMessage.tone === 'success'
              ? 'border-emerald-700/60 bg-emerald-900/20 text-emerald-200'
              : statusMessage.tone === 'error'
                ? 'border-rose-700/60 bg-rose-900/20 text-rose-200'
                : 'border-zinc-700 bg-zinc-900 text-zinc-200'
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-3 text-sm font-semibold tracking-wide text-zinc-200 uppercase">
            Create Master Run
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs text-zinc-400">
              <span>Persona</span>
              <select
                value={selectedPersonaId}
                onChange={(event) => setSelectedPersonaId(event.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
              >
                <option value="">Select persona</option>
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-zinc-400">
              <span>Workspace ID</span>
              <input
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
                placeholder="main"
              />
            </label>
          </div>
          <label className="mt-3 block space-y-1 text-xs text-zinc-400">
            <span>Title</span>
            <input
              value={runTitle}
              onChange={(event) => setRunTitle(event.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
            />
          </label>
          <label className="mt-3 block space-y-1 text-xs text-zinc-400">
            <span>Contract</span>
            <textarea
              value={runContract}
              onChange={(event) => setRunContract(event.target.value)}
              rows={4}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100"
              placeholder="Describe what Master should complete end-to-end."
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void createRun()}
              disabled={loading}
              className="rounded bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Working...' : 'Create Master Run'}
            </button>
            <button
              type="button"
              onClick={() => void refreshAll()}
              disabled={loading}
              className="rounded border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-800 disabled:opacity-60"
            >
              Refresh
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-3 text-sm font-semibold tracking-wide text-zinc-200 uppercase">
            Metrics
          </h3>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-zinc-400">Completion</dt>
              <dd className="font-medium text-zinc-100">
                {metrics?.run_completion_rate !== undefined
                  ? `${Math.round((Number(metrics.run_completion_rate) || 0) * 100)}%`
                  : 'n/a'}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-400">Verify Pass</dt>
              <dd className="font-medium text-zinc-100">
                {metrics?.verify_pass_rate !== undefined
                  ? `${Math.round((Number(metrics.verify_pass_rate) || 0) * 100)}%`
                  : 'n/a'}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-zinc-400">Delegation Success</dt>
              <dd className="font-medium text-zinc-100">
                {metrics?.delegation_success_rate !== undefined
                  ? `${Math.round((Number(metrics.delegation_success_rate) || 0) * 100)}%`
                  : 'n/a'}
              </dd>
            </div>
            <div className="pt-2 text-[11px] text-zinc-500">
              Updated: {String(metrics?.generated_at || 'n/a')}
            </div>
          </dl>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-3 text-sm font-semibold tracking-wide text-zinc-200 uppercase">Runs</h3>
          {!runs.length ? (
            <p className="text-sm text-zinc-400">No runs yet.</p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => setSelectedRunId(run.id)}
                  className={`w-full rounded border p-3 text-left transition ${
                    selectedRunId === run.id
                      ? 'border-indigo-500 bg-indigo-900/20'
                      : 'border-zinc-700 bg-zinc-950/60 hover:bg-zinc-900'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-zinc-100">{run.title}</span>
                    <span className="text-[11px] text-zinc-400">{run.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">{run.contract}</p>
                  <div className="mt-2 h-1.5 w-full rounded bg-zinc-800">
                    <div
                      className="h-1.5 rounded bg-emerald-500"
                      style={{ width: `${run.progress}%` }}
                    />
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-3 text-sm font-semibold tracking-wide text-zinc-200 uppercase">
            Run Controls
          </h3>
          {!selectedRun ? (
            <p className="text-sm text-zinc-400">Select a run.</p>
          ) : (
            <div className="space-y-3">
              <div className="rounded border border-zinc-700 bg-zinc-950/60 p-3 text-xs text-zinc-300">
                <div>ID: {selectedRun.id}</div>
                <div>Status: {selectedRun.status}</div>
                <div>Progress: {selectedRun.progress}%</div>
                <div>Paused for approval: {selectedRun.pausedForApproval ? 'yes' : 'no'}</div>
                {selectedRun.lastError && (
                  <div className="mt-1 text-rose-300">Error: {selectedRun.lastError}</div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void startRun(selectedRun.id)}
                  disabled={loading}
                  className="rounded bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
                >
                  Start Run
                </button>
                <button
                  type="button"
                  onClick={() => void exportRun(selectedRun.id)}
                  disabled={loading}
                  className="rounded border border-zinc-600 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-60"
                >
                  Export Bundle
                </button>
              </div>
              <div className="rounded border border-zinc-700 bg-zinc-950/60 p-3">
                <h4 className="text-xs font-semibold tracking-wide text-zinc-300 uppercase">
                  Approval Decision
                </h4>
                <label className="mt-2 block space-y-1 text-xs text-zinc-400">
                  <span>Action Type</span>
                  <input
                    value={actionType}
                    onChange={(event) => setActionType(event.target.value)}
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                    placeholder="gmail.send"
                  />
                </label>
                <label className="mt-2 block space-y-1 text-xs text-zinc-400">
                  <span>Decision</span>
                  <select
                    value={decision}
                    onChange={(event) =>
                      setDecision(event.target.value as 'approve_once' | 'approve_always' | 'deny')
                    }
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                  >
                    <option value="approve_once">approve_once</option>
                    <option value="approve_always">approve_always</option>
                    <option value="deny">deny</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void submitDecision()}
                  disabled={loading}
                  className="mt-3 rounded bg-zinc-700 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-600 disabled:opacity-60"
                >
                  Apply Decision
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {exportBundle && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h3 className="mb-2 text-sm font-semibold tracking-wide text-zinc-200 uppercase">
            Export Bundle
          </h3>
          <pre className="max-h-72 overflow-auto rounded border border-zinc-700 bg-zinc-950 p-3 text-xs text-zinc-200">
            {exportBundle}
          </pre>
        </section>
      )}

      <MasterLearningPanel metrics={metrics} />
    </section>
  );
};

export default MasterView;
