'use client';

import React from 'react';
import { useCronRules, type UseCronRulesResult } from '@/modules/cron/hooks/useCronRules';
import type { CronRule, CronRunStatus } from '@/modules/cron/types';

interface CronViewProps {
  state?: UseCronRulesResult;
}

const STATUS_CLASS: Record<CronRunStatus, string> = {
  queued: 'text-amber-300 bg-amber-900/30 border-amber-700/30',
  running: 'text-sky-300 bg-sky-900/30 border-sky-700/30',
  succeeded: 'text-emerald-300 bg-emerald-900/30 border-emerald-700/30',
  failed: 'text-rose-300 bg-rose-900/30 border-rose-700/30',
  dead_letter: 'text-red-300 bg-red-900/30 border-red-700/30',
  skipped: 'text-zinc-300 bg-zinc-800 border-zinc-700',
};

function formatDateTime(value: string | null): string {
  if (!value) return 'n/a';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function formatLeaseAge(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  return `${Math.floor(value / 3600)}h`;
}

function ruleStatus(rule: CronRule): string {
  if (!rule.enabled) return 'Paused';
  if (rule.lastError) return 'Needs attention';
  return 'Active';
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
      <div className="text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}

const CronView: React.FC<CronViewProps> = ({ state }) => {
  const hookState = useCronRules();
  const cron = state ?? hookState;
  const selectedRule = cron.rules.find((rule) => rule.id === cron.selectedRuleId) ?? null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-white">Cron</h2>
          <p className="text-sm text-zinc-400">
            Manage automation schedules, trigger manual runs, and inspect execution history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void cron.actions.refreshAll();
            }}
            disabled={cron.loading || cron.refreshing}
            className="rounded-md border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cron.refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={cron.actions.startCreate}
            className="rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500"
          >
            New Cron Job
          </button>
        </div>
      </header>

      {cron.error && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {cron.error}
        </div>
      )}
      {cron.statusMessage && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            cron.statusMessage.tone === 'success'
              ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200'
              : cron.statusMessage.tone === 'error'
                ? 'border-rose-800 bg-rose-950/40 text-rose-200'
                : 'border-zinc-700 bg-zinc-900 text-zinc-100'
          }`}
        >
          {cron.statusMessage.text}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-5">
        <MetricCard label="Active" value={cron.metrics?.activeRules ?? 0} />
        <MetricCard label="Queued" value={cron.metrics?.queuedRuns ?? 0} />
        <MetricCard label="Running" value={cron.metrics?.runningRuns ?? 0} />
        <MetricCard label="Dead Letter" value={cron.metrics?.deadLetterRuns ?? 0} />
        <MetricCard label="Lease Age" value={formatLeaseAge(cron.metrics?.leaseAgeSeconds)} />
      </section>

      {cron.loading ? (
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-6 text-sm text-zinc-300">
          Loading cron rules...
        </section>
      ) : (
        <section className="grid gap-4 lg:grid-cols-5">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 lg:col-span-3">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <h3 className="text-sm font-semibold text-zinc-200">Rules</h3>
              <span className="text-xs text-zinc-500">{cron.rules.length} total</span>
            </div>
            {!cron.rules.length ? (
              <div className="px-4 py-8 text-sm text-zinc-400">No cron jobs yet</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-xs">
                  <thead className="text-zinc-500 uppercase">
                    <tr className="border-b border-zinc-800">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Schedule</th>
                      <th className="px-4 py-3">Timezone</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cron.rules.map((rule) => {
                      const isSelected = cron.selectedRuleId === rule.id;
                      const isPending = cron.pendingRuleId === rule.id;
                      return (
                        <tr
                          key={rule.id}
                          className={`border-b border-zinc-800/80 ${
                            isSelected ? 'bg-zinc-800/40' : 'hover:bg-zinc-800/20'
                          }`}
                          onClick={() => cron.actions.selectRule(rule.id)}
                        >
                          <td className="px-4 py-3">
                            <div className="font-medium text-zinc-200">{rule.name}</div>
                            <div className="text-[11px] text-zinc-500">
                              Next: {formatDateTime(rule.nextRunAt)}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono text-zinc-300">
                            {rule.cronExpression}
                          </td>
                          <td className="px-4 py-3 text-zinc-300">{rule.timezone}</td>
                          <td className="px-4 py-3 text-zinc-300">{ruleStatus(rule)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void cron.actions.runNow(rule.id);
                                }}
                                disabled={isPending}
                                className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-100 transition hover:bg-zinc-800 disabled:opacity-50"
                              >
                                Run now
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void cron.actions.toggleRule(rule.id, !rule.enabled);
                                }}
                                disabled={isPending}
                                className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-100 transition hover:bg-zinc-800 disabled:opacity-50"
                              >
                                {rule.enabled ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  cron.actions.startEdit(rule);
                                }}
                                className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-100 transition hover:bg-zinc-800"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void cron.actions.deleteRule(rule.id);
                                }}
                                disabled={isPending}
                                className="rounded border border-rose-700/70 px-2 py-1 text-[11px] text-rose-200 transition hover:bg-rose-900/40 disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="space-y-4 lg:col-span-2">
            <section className="rounded-lg border border-zinc-800 bg-zinc-900/60">
              <header className="border-b border-zinc-800 px-4 py-3">
                <h3 className="text-sm font-semibold text-zinc-200">
                  {cron.formMode === 'edit' ? 'Edit Rule' : 'Create Rule'}
                </h3>
              </header>
              <form
                className="space-y-3 p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void cron.actions.submitForm();
                }}
              >
                <label className="block space-y-1 text-xs text-zinc-400">
                  <span>Name</span>
                  <input
                    value={cron.draft.name}
                    onChange={(event) => cron.actions.updateDraft({ name: event.target.value })}
                    placeholder="Morning Briefing"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                  />
                  {cron.validationErrors.name && (
                    <span className="text-[11px] text-rose-300">{cron.validationErrors.name}</span>
                  )}
                </label>
                <label className="block space-y-1 text-xs text-zinc-400">
                  <span>Cron Expression</span>
                  <input
                    value={cron.draft.cronExpression}
                    onChange={(event) =>
                      cron.actions.updateDraft({ cronExpression: event.target.value })
                    }
                    placeholder="0 9 * * *"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-zinc-100"
                  />
                  {cron.validationErrors.cronExpression && (
                    <span className="text-[11px] text-rose-300">
                      {cron.validationErrors.cronExpression}
                    </span>
                  )}
                </label>
                <label className="block space-y-1 text-xs text-zinc-400">
                  <span>Timezone</span>
                  <input
                    value={cron.draft.timezone}
                    onChange={(event) => cron.actions.updateDraft({ timezone: event.target.value })}
                    placeholder="UTC"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                  />
                </label>
                <label className="block space-y-1 text-xs text-zinc-400">
                  <span>Prompt</span>
                  <textarea
                    value={cron.draft.prompt}
                    onChange={(event) => cron.actions.updateDraft({ prompt: event.target.value })}
                    rows={4}
                    placeholder="Summarize overnight activity."
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
                  />
                  {cron.validationErrors.prompt && (
                    <span className="text-[11px] text-rose-300">
                      {cron.validationErrors.prompt}
                    </span>
                  )}
                </label>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={cron.draft.enabled}
                    onChange={(event) =>
                      cron.actions.updateDraft({ enabled: event.target.checked })
                    }
                  />
                  Enabled
                </label>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={cron.submitting}
                    className="rounded bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {cron.submitting
                      ? 'Saving...'
                      : cron.formMode === 'edit'
                        ? 'Save Changes'
                        : 'Create Rule'}
                  </button>
                  <button
                    type="button"
                    onClick={cron.actions.cancelForm}
                    className="rounded border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-800"
                  >
                    Reset
                  </button>
                </div>
              </form>
            </section>

            <section className="rounded-lg border border-zinc-800 bg-zinc-900/60">
              <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-200">Run History</h3>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    Run history depth controls how many recent runs are requested.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="cron-history-depth" className="text-[11px] text-zinc-500">
                    Run history depth
                  </label>
                  <select
                    id="cron-history-depth"
                    value={String(cron.historyLimit)}
                    onChange={(event) =>
                      cron.actions.setHistoryLimit(Number.parseInt(event.target.value, 10))
                    }
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200"
                  >
                    <option value="20">20</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="200">200</option>
                    <option value="500">500</option>
                  </select>
                  {selectedRule && (
                    <span className="text-xs text-zinc-500">{selectedRule.name}</span>
                  )}
                </div>
              </header>
              <div className="space-y-2 p-4">
                {cron.historyLoading && (
                  <div className="text-xs text-zinc-400">Loading run history...</div>
                )}
                {cron.historyError && (
                  <div className="text-xs text-rose-300">{cron.historyError}</div>
                )}
                {!cron.historyLoading && !cron.historyError && !cron.runs.length && (
                  <div className="text-xs text-zinc-400">No runs for the selected rule yet.</div>
                )}
                {!cron.historyLoading &&
                  !cron.historyError &&
                  cron.runs.map((run) => (
                    <article
                      key={run.id}
                      className="rounded border border-zinc-800 bg-zinc-950/70 p-3"
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                            STATUS_CLASS[run.status]
                          }`}
                        >
                          {run.status.replace('_', ' ')}
                        </span>
                        <span className="text-[11px] text-zinc-500">
                          {formatDateTime(run.createdAt)}
                        </span>
                      </div>
                      {run.errorMessage && (
                        <p className="mt-2 text-xs text-rose-300">{run.errorMessage}</p>
                      )}
                      {run.resultSummary && (
                        <p className="mt-2 text-xs text-zinc-300">{run.resultSummary}</p>
                      )}
                    </article>
                  ))}
              </div>
            </section>
          </div>
        </section>
      )}
    </div>
  );
};

export default CronView;
