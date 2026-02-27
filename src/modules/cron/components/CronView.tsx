'use client';

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { useCronRules, type UseCronRulesResult } from '@/modules/cron/hooks/useCronRules';
import { CronMetricsPanel } from '@/modules/cron/components/CronMetricsPanel';
import { CronRuleTable } from '@/modules/cron/components/CronRuleTable';
import { CronRuleForm } from '@/modules/cron/components/CronRuleForm';
import { CronRunHistory } from '@/modules/cron/components/CronRunHistory';

const FlowBuilderView = dynamic(
  () => import('@/modules/flow-builder/FlowBuilderView').then((m) => m.FlowBuilderView),
  { ssr: false, loading: () => <div className="p-8 text-zinc-500">Loading flow editor…</div> },
);

interface CronViewProps {
  state?: UseCronRulesResult;
}

const CronView: React.FC<CronViewProps> = ({ state }) => {
  const hookState = useCronRules();
  const cron = state ?? hookState;
  const selectedRule = cron.rules.find((rule) => rule.id === cron.selectedRuleId) ?? null;
  const [flowBuilderRuleId, setFlowBuilderRuleId] = useState<string | null>(null);

  // ── Flow Builder overlay ──────────────────────────────────────────────────
  if (flowBuilderRuleId) {
    return (
      <div className="h-screen">
        <FlowBuilderView
          ruleId={flowBuilderRuleId}
          ruleName={cron.rules.find((r) => r.id === flowBuilderRuleId)?.name ?? 'Flow'}
          onBack={() => setFlowBuilderRuleId(null)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* ── Page Header ──────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tight text-white">Cron</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Manage automation schedules, trigger manual runs, and inspect execution history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void cron.actions.refreshAll()}
            disabled={cron.loading || cron.refreshing}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-bold uppercase tracking-wide text-zinc-300 transition-all hover:bg-zinc-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cron.refreshing ? (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                Refreshing…
              </span>
            ) : (
              'Refresh'
            )}
          </button>
          <button
            type="button"
            onClick={cron.actions.startCreate}
            className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold uppercase tracking-wide text-white transition-all hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            + New Cron Job
          </button>
        </div>
      </header>

      {/* ── Status Messages ───────────────────────────────────────────────── */}
      {cron.error && (
        <div className="rounded-xl border border-rose-800/50 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
          <span className="mr-2 font-bold">Error:</span>
          {cron.error}
        </div>
      )}
      {cron.statusMessage && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            cron.statusMessage.tone === 'success'
              ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald-200'
              : cron.statusMessage.tone === 'error'
                ? 'border-rose-800/50 bg-rose-950/30 text-rose-200'
                : 'border-zinc-700 bg-zinc-900 text-zinc-100'
          }`}
        >
          {cron.statusMessage.tone === 'success' && <span className="mr-2">✓</span>}
          {cron.statusMessage.text}
        </div>
      )}

      {/* ── Metrics ──────────────────────────────────────────────────────── */}
      <CronMetricsPanel metrics={cron.metrics} />

      {/* ── Main Content ─────────────────────────────────────────────────── */}
      {cron.loading ? (
        <section className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-8 text-sm text-zinc-300">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-700 border-t-indigo-400" />
          Loading cron rules...
        </section>
      ) : (
        <section className="grid gap-4 lg:grid-cols-5">
          {/* ── Rules Table (left / main) ─────────────────────────────── */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 lg:col-span-3">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <h3 className="text-sm font-bold text-zinc-100">Rules</h3>
              <span className="rounded bg-zinc-800/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                {cron.rules.length} total
              </span>
            </div>
            <CronRuleTable
              rules={cron.rules}
              selectedRuleId={cron.selectedRuleId}
              pendingRuleId={cron.pendingRuleId}
              onSelectRule={cron.actions.selectRule}
              onRunNow={cron.actions.runNow}
              onToggleRule={cron.actions.toggleRule}
              onStartEdit={cron.actions.startEdit}
              onDeleteRule={cron.actions.deleteRule}
              onOpenFlowBuilder={setFlowBuilderRuleId}
            />
          </div>

          {/* ── Right Panel: Form + History ───────────────────────────── */}
          <div className="space-y-4 lg:col-span-2">
            <CronRuleForm
              formMode={cron.formMode}
              draft={cron.draft}
              validationErrors={cron.validationErrors}
              submitting={cron.submitting}
              onUpdateDraft={cron.actions.updateDraft}
              onSubmit={cron.actions.submitForm}
              onCancel={cron.actions.cancelForm}
            />

            <CronRunHistory
              runs={cron.runs}
              historyLimit={cron.historyLimit}
              historyLoading={cron.historyLoading}
              historyError={cron.historyError}
              selectedRuleName={selectedRule?.name ?? null}
              onSetHistoryLimit={cron.actions.setHistoryLimit}
            />
          </div>
        </section>
      )}
    </div>
  );
};

export default CronView;
