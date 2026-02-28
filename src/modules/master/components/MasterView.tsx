'use client';

import React from 'react';
import { useMasterView } from '@/modules/master/hooks/useMasterView';
import ViewErrorBoundary from '@/components/ViewErrorBoundary';
import { CreateRunForm } from './CreateRunForm';
import { RunList } from './RunList';
import { RunControls } from './RunControls';
import { MetricsPanel } from './MetricsPanel';
import { ExportBundlePanel } from './ExportBundlePanel';
import { RunDetailPanel } from './RunDetailPanel';
import { RunFeedbackPanel } from './RunFeedbackPanel';
import MasterLearningPanel from './MasterLearningPanel';

// ─── Status banner ────────────────────────────────────────────────────────────

function StatusBanner({
  tone,
  text,
  onDismiss,
}: {
  tone: 'info' | 'success' | 'error';
  text: string;
  onDismiss: () => void;
}) {
  const cls =
    tone === 'success'
      ? 'border-emerald-700/60 bg-emerald-900/20 text-emerald-200'
      : tone === 'error'
        ? 'border-rose-700/60 bg-rose-900/20 text-rose-200'
        : 'border-indigo-700/40 bg-indigo-900/10 text-indigo-200';

  const icon =
    tone === 'success' ? (
      <svg
        className="h-4 w-4 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ) : tone === 'error' ? (
      <svg
        className="h-4 w-4 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v3.75m9.303 3.376c.866 1.5-.217 3.374-1.948 3.374H4.645c-1.73 0-2.813-1.874-1.948-3.374L10.05 3.378c.866-1.5 3.032-1.5 3.898 0l5.355 9.748zM12 15.75h.008v.008H12v-.008z"
        />
      </svg>
    ) : (
      <svg
        className="h-4 w-4 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    );

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-sm ${cls}`}
    >
      <div className="flex items-center gap-2.5">
        {icon}
        <span className="font-medium">{text}</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-lg p-1 text-current opacity-50 transition-all hover:bg-white/10 hover:opacity-100"
        aria-label="Dismiss"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.5}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}

// ─── MasterView ───────────────────────────────────────────────────────────────

const MasterView: React.FC = () => {
  const view = useMasterView();

  return (
    <section className="space-y-6">
      {/* ── Hero header ── */}
      <header className="group relative flex flex-col justify-between gap-6 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/40 p-8 shadow-2xl md:flex-row md:items-center">
        {/* decorative glow blobs */}
        <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-indigo-600/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-16 -left-16 h-40 w-40 rounded-full bg-violet-600/8 blur-3xl" />

        <div className="relative z-10">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="text-3xl font-black tracking-tight text-white uppercase">Master</h2>
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/80 px-2.5 py-1">
              <span
                className={`h-2 w-2 rounded-full ${view.hasActiveRuns ? 'animate-pulse bg-emerald-400' : 'bg-zinc-600'}`}
                aria-hidden="true"
              />
              <span className="font-mono text-[10px] font-semibold tracking-wider text-zinc-400">
                {view.hasActiveRuns ? '1 RING' : `${view.runs.length} RUNS`}
              </span>
            </div>
          </div>
          <p className="max-w-lg text-sm leading-relaxed text-zinc-500">
            Create Master Run contracts, execute autonomously, review approvals, and export verified
            bundles.
          </p>
        </div>

        {/* right-side quick stats */}
        <div className="relative z-10 flex shrink-0 items-center gap-4">
          {view.metrics && (
            <>
              <div className="text-center">
                <div className="font-mono text-xl font-black text-white tabular-nums">
                  {Math.round((view.metrics.run_completion_rate ?? 0) * 100)}%
                </div>
                <div className="font-mono text-[9px] tracking-widest text-zinc-600 uppercase">
                  Done
                </div>
              </div>
              <div className="h-8 w-px bg-zinc-800" />
              <div className="text-center">
                <div className="font-mono text-xl font-black text-white tabular-nums">
                  {Math.round((view.metrics.verify_pass_rate ?? 0) * 100)}%
                </div>
                <div className="font-mono text-[9px] tracking-widest text-zinc-600 uppercase">
                  Pass
                </div>
              </div>
              <div className="h-8 w-px bg-zinc-800" />
              <div className="text-center">
                <div className="font-mono text-xl font-black text-white tabular-nums">
                  {Math.round((view.metrics.delegation_success_rate ?? 0) * 100)}%
                </div>
                <div className="font-mono text-[9px] tracking-widest text-zinc-600 uppercase">
                  Delegated
                </div>
              </div>
            </>
          )}
        </div>
      </header>

      {/* ── Status banner ── */}
      {view.statusMessage && (
        <StatusBanner
          tone={view.statusMessage.tone}
          text={view.statusMessage.text}
          onDismiss={view.dismissStatus}
        />
      )}

      {/* ── Create + Metrics ── */}
      <div className="grid gap-5 xl:grid-cols-[2fr_1fr]">
        <ViewErrorBoundary label="Create Run Form">
          <CreateRunForm
            personas={view.personas}
            workspaces={view.workspaces}
            selectedPersonaId={view.selectedPersonaId}
            workspaceId={view.workspaceId}
            runTitle={view.runTitle}
            runContract={view.runContract}
            loading={view.loading}
            onPersonaChange={view.setSelectedPersonaId}
            onWorkspaceChange={view.setWorkspaceId}
            onTitleChange={view.setRunTitle}
            onContractChange={view.setRunContract}
            onCreateRun={() => void view.createRun()}
            onRefresh={() => void view.refreshAll()}
          />
        </ViewErrorBoundary>
        <ViewErrorBoundary label="Metrics Panel">
          <MetricsPanel metrics={view.metrics} />
        </ViewErrorBoundary>
      </div>

      {/* ── Runs + Controls ── */}
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <ViewErrorBoundary label="Run List">
          <RunList
            runs={view.paginatedRuns}
            selectedRunId={view.selectedRunId}
            runsPage={view.runsPage}
            totalRunPages={view.totalRunPages}
            onSelectRun={view.setSelectedRunId}
            onPageChange={view.setRunsPage}
          />
        </ViewErrorBoundary>
        <ViewErrorBoundary label="Run Controls">
          <RunControls
            selectedRun={view.selectedRun}
            loading={view.loading}
            onStartRun={(id) => void view.startRun(id)}
            onExportRun={(id) => void view.exportRun(id)}
            onCancelRun={(id) => void view.cancelRun(id)}
            onSubmitDecision={(actionType, decision) =>
              void view.submitDecision(actionType, decision)
            }
          />
        </ViewErrorBoundary>
      </div>

      {/* ── Run detail (steps) ── */}
      {view.selectedRunDetail && view.selectedRunDetail.steps.length > 0 && (
        <ViewErrorBoundary label="Run Detail">
          <RunDetailPanel steps={view.selectedRunDetail.steps} />
        </ViewErrorBoundary>
      )}

      {/* ── Feedback – only for completed runs ── */}
      {view.selectedRun?.status === 'COMPLETED' && (
        <ViewErrorBoundary key={view.selectedRun.id} label="Run Feedback">
          <RunFeedbackPanel
            runId={view.selectedRun.id}
            loading={view.loadingAction === 'submitting-feedback'}
            onSubmit={(input) => void view.submitFeedback(input)}
          />
        </ViewErrorBoundary>
      )}

      {/* ── Export bundle ── */}
      {view.exportBundle && (
        <ExportBundlePanel
          exportBundle={view.exportBundle.data}
          runId={view.exportBundle.runId}
          onDismiss={view.dismissExportBundle}
        />
      )}

      {/* ── Learning loop ── */}
      <ViewErrorBoundary label="Learning Loop">
        <MasterLearningPanel metrics={view.metrics} />
      </ViewErrorBoundary>
    </section>
  );
};

export default MasterView;
