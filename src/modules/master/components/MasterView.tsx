'use client';

import React, { useState } from 'react';
import { useMasterView } from '@/modules/master/hooks/useMasterView';
import ViewErrorBoundary from '@/components/ViewErrorBoundary';
import MasterEntryPage from './MasterEntryPage';
import { CreateRunForm } from './CreateRunForm';
import { RunList } from './RunList';
import { RunControls } from './RunControls';
import { MetricsPanel } from './MetricsPanel';
import { ExportBundlePanel } from './ExportBundlePanel';
import { RunDetailPanel } from './RunDetailPanel';
import { RunFeedbackPanel } from './RunFeedbackPanel';
import MasterLearningPanel from './MasterLearningPanel';

// ─── Tab types ────────────────────────────────────────────────────────────────

type Tab = 'new' | 'runs' | 'analytics';

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
  const [activeTab, setActiveTab] = useState<Tab>('new');
  const [showEntry, setShowEntry] = useState(true);

  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: string | number }[] = [
    {
      id: 'new',
      label: 'New Run',
      icon: (
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      ),
    },
    {
      id: 'runs',
      label: 'Runs',
      badge: view.runs.length > 0 ? view.runs.length : undefined,
      icon: (
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
            strokeWidth={2}
            d="M4 6h16M4 10h16M4 14h16M4 18h7"
          />
        </svg>
      ),
    },
    {
      id: 'analytics',
      label: 'Analytics',
      icon: (
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
            strokeWidth={2}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
      ),
    },
  ];

  if (showEntry) {
    return (
      <MasterEntryPage
        onEnterDashboard={() => setShowEntry(false)}
        personaId={view.selectedPersonaId}
        workspaceId={view.workspaceId}
      />
    );
  }

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

      {/* ── Tab bar ── */}
      <div className="flex items-center gap-1 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-1.5">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold tracking-wide transition-all ${
                isActive
                  ? 'bg-zinc-800 text-white shadow-sm'
                  : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
              }`}
              aria-selected={isActive}
              role="tab"
            >
              <span className={isActive ? 'text-indigo-400' : 'text-current'}>{tab.icon}</span>
              <span>{tab.label}</span>
              {tab.badge !== undefined && (
                <span
                  className={`rounded-md px-1.5 py-0.5 font-mono text-[9px] font-semibold ${
                    isActive ? 'bg-indigo-500/20 text-indigo-300' : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {tab.badge}
                </span>
              )}
              {/* active underline accent */}
              {isActive && (
                <span className="absolute bottom-0.5 left-1/2 h-0.5 w-6 -translate-x-1/2 rounded-full bg-indigo-500" />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Tab: New Run ── */}
      {activeTab === 'new' && (
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
            onCreateRun={() => {
              void view.createRun();
              setActiveTab('runs');
            }}
            onRefresh={() => void view.refreshAll()}
          />
        </ViewErrorBoundary>
      )}

      {/* ── Tab: Runs ── */}
      {activeTab === 'runs' && (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
            <ViewErrorBoundary label="Run List">
              <RunList
                runs={view.runs}
                selectedRunId={view.selectedRunId}
                onSelectRun={view.setSelectedRunId}
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

          {/* Run detail steps */}
          {view.selectedRunDetail && view.selectedRunDetail.steps.length > 0 && (
            <ViewErrorBoundary label="Run Detail">
              <RunDetailPanel steps={view.selectedRunDetail.steps} />
            </ViewErrorBoundary>
          )}

          {/* Feedback – only for completed runs */}
          {view.selectedRun?.status === 'COMPLETED' && (
            <ViewErrorBoundary key={view.selectedRun.id} label="Run Feedback">
              <RunFeedbackPanel
                runId={view.selectedRun.id}
                loading={view.loadingAction === 'submitting-feedback'}
                onSubmit={view.submitFeedback}
              />
            </ViewErrorBoundary>
          )}

          {/* Export bundle */}
          {view.exportBundle && (
            <ExportBundlePanel
              exportBundle={view.exportBundle.data}
              runId={view.exportBundle.runId}
              onDismiss={view.dismissExportBundle}
            />
          )}
        </div>
      )}

      {/* ── Tab: Analytics ── */}
      {activeTab === 'analytics' && (
        <div className="space-y-5">
          <ViewErrorBoundary label="Metrics Panel">
            <MetricsPanel metrics={view.metrics} />
          </ViewErrorBoundary>
          <ViewErrorBoundary label="Learning Loop">
            <MasterLearningPanel metrics={view.metrics} />
          </ViewErrorBoundary>
        </div>
      )}
    </section>
  );
};

export default MasterView;
