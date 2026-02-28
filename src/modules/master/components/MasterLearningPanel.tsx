import React from 'react';
import type { MasterMetrics } from '@/modules/master/types';

// ─── Label mapping ────────────────────────────────────────────────────────────

const METRIC_LABELS: Record<string, string> = {
  learning_cycle_success_rate: 'Learning Cycle Success',
  tool_forge_success_rate: 'Tool Forge Success',
};

function formatMetricValue(value: unknown): string {
  if (value === undefined || value === null) return 'n/a';
  const num = Number(value);
  if (!Number.isFinite(num)) return 'n/a';
  // Rates are 0–1, display as percentage
  if (num >= 0 && num <= 1) return `${Math.round(num * 100)}%`;
  return num.toFixed(2);
}

// ─── Component ────────────────────────────────────────────────────────────────

interface MasterLearningPanelProps {
  metrics?: MasterMetrics | null;
}

const MasterLearningPanel: React.FC<MasterLearningPanelProps> = ({ metrics }) => {
  const learningKeys = ['learning_cycle_success_rate', 'tool_forge_success_rate'] as const;

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      {/* Header */}
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-teal-500/15">
              <svg
                className="h-3.5 w-3.5 text-teal-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4.871 4A17.926 17.926 0 003 12c0 2.874.673 5.59 1.871 8m14.13 0a17.926 17.926 0 001.87-8 17.926 17.926 0 00-1.87-8M9 9h1.246a1 1 0 01.961.725l1.586 5.55a1 1 0 00.961.725H15m1-7h-.08a2 2 0 00-1.519.698L9.6 15.302A2 2 0 018.08 16H8"
                />
              </svg>
            </div>
            <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
              Learning Loop
            </h3>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-500/70" aria-hidden="true" />
            <span className="font-mono text-[9px] font-semibold tracking-wider text-zinc-500">
              DAILY 03:00
            </span>
          </div>
        </div>
      </div>

      <div className="p-6">
        <p className="mb-4 text-xs leading-relaxed text-zinc-500">
          Scheduled learning run daily at 03:00 (server time), preemptible and budget-limited.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {learningKeys.map((key) => {
            const value = formatMetricValue(metrics?.[key]);
            const isN = value === 'n/a';
            return (
              <div
                key={key}
                className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-4 transition-colors hover:border-zinc-700/80"
              >
                <div className="mb-2 text-[9px] font-bold tracking-widest text-zinc-600 uppercase">
                  {METRIC_LABELS[key] ?? key}
                </div>
                <div
                  className={`font-mono text-2xl font-black tabular-nums ${isN ? 'text-zinc-600' : 'text-white'}`}
                >
                  {value}
                </div>
                {!isN && (
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-teal-500 transition-all duration-700"
                      style={{ width: value }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default MasterLearningPanel;
