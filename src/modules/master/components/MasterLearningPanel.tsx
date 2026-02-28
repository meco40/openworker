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
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
          Learning Loop
        </h3>
        <span className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] text-zinc-600">
          Daily 03:00
        </span>
      </div>

      <p className="mb-3 text-xs text-zinc-500">
        Scheduled learning run daily at 03:00 (server time), preemptible and budget-limited.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {learningKeys.map((key) => (
          <div key={key} className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2.5">
            <div className="text-[9px] font-bold tracking-widest text-zinc-600 uppercase">
              {METRIC_LABELS[key] ?? key}
            </div>
            <div className="mt-1 text-sm font-bold text-zinc-200 tabular-nums">
              {formatMetricValue(metrics?.[key])}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

export default MasterLearningPanel;
