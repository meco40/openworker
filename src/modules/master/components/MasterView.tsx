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
        : 'border-zinc-700 bg-zinc-900 text-zinc-200';

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-sm ${cls}`}
    >
      <span>{text}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 text-current opacity-60 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// ─── MasterView ───────────────────────────────────────────────────────────────

const MasterView: React.FC = () => {
  const view = useMasterView();

  return (
    <section className="space-y-5">
      {/* ── Hero header ── */}
      <header className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900/40 p-6 shadow-2xl">
        <div className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full bg-indigo-600/8 blur-3xl" />
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1.5 flex items-center gap-3">
              <h2 className="text-3xl font-black tracking-tight text-white uppercase">Master</h2>
              <div className="flex items-center gap-1.5 rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
                <span
                  className={`h-2 w-2 rounded-full ${view.hasActiveRuns ? 'animate-pulse bg-emerald-500' : 'bg-zinc-600'}`}
                  aria-hidden="true"
                />
                <span className="font-mono text-[10px] text-zinc-400">
                  {view.hasActiveRuns ? 'ACTIVE' : `${view.runs.length} RUNS`}
                </span>
              </div>
            </div>
            <p className="max-w-lg text-sm leading-relaxed text-zinc-500">
              Create Master Run contracts, execute autonomously, review approvals, and export
              verified bundles.
            </p>
          </div>
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
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
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
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
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
        <ViewErrorBoundary label="Run Feedback">
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
