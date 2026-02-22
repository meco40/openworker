import React, { useState } from 'react';
import type { DebugTurn } from '../types';

interface TurnDetailPanelProps {
  turn: DebugTurn | null;
  onReplayFrom: (seq: number) => void;
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-3 border-b border-zinc-800 pb-3 last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-1 flex w-full items-center justify-between text-xs font-medium text-zinc-400 hover:text-zinc-200"
      >
        <span>{title}</span>
        <span className="text-zinc-600">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div>{children}</div>}
    </div>
  );
};

function riskBadge(level: string | undefined): React.ReactNode {
  if (level === 'HIGH')
    return (
      <span className="rounded bg-red-900/60 px-1.5 py-0.5 text-[10px] text-red-300">
        HIGH RISK
      </span>
    );
  if (level === 'MEDIUM')
    return (
      <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-300">
        MEDIUM RISK
      </span>
    );
  return (
    <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 text-[10px] text-emerald-300">
      LOW RISK
    </span>
  );
}

const TurnDetailPanel: React.FC<TurnDetailPanelProps> = ({ turn, onReplayFrom }) => {
  if (!turn) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        Select a turn to inspect it.
      </div>
    );
  }

  const totalTokens = (turn.promptTokens ?? 0) + (turn.completionTokens ?? 0);
  const promptPct =
    totalTokens > 0 ? Math.round(((turn.promptTokens ?? 0) / totalTokens) * 100) : 0;

  return (
    <div className="flex h-full flex-col gap-0 overflow-auto text-xs">
      {/* Header */}
      <div className="mb-3 flex items-center gap-3 border-b border-zinc-800 pb-3">
        <span className="rounded bg-blue-800 px-2 py-0.5 text-sm font-bold text-blue-100">
          T{turn.seq}
        </span>
        {turn.modelName && (
          <span className="max-w-[200px] truncate text-zinc-500">{turn.modelName}</span>
        )}
        {riskBadge(turn.riskLevel)}
        {turn.latencyMs != null && (
          <span className="ml-auto text-zinc-500">{turn.latencyMs}ms</span>
        )}
      </div>

      {/* Token bar */}
      {totalTokens > 0 && (
        <Section title={`Tokens — ${totalTokens.toLocaleString()} total`}>
          <div className="mb-1 flex h-3 overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full bg-blue-600"
              style={{ width: `${String(promptPct)}%` }}
              title={`Prompt: ${String(turn.promptTokens ?? 0)}`}
            />
            <div
              className="h-full bg-violet-500"
              style={{ width: `${String(100 - promptPct)}%` }}
              title={`Completion: ${String(turn.completionTokens ?? 0)}`}
            />
          </div>
          <div className="flex gap-4 text-zinc-500">
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-blue-600" />
              Prompt {(turn.promptTokens ?? 0).toLocaleString()}
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-violet-500" />
              Completion {(turn.completionTokens ?? 0).toLocaleString()}
            </span>
          </div>
        </Section>
      )}

      {/* User preview */}
      {turn.userPreview && (
        <Section title="User Message">
          <p className="leading-relaxed break-words whitespace-pre-wrap text-zinc-300">
            {turn.userPreview}
          </p>
        </Section>
      )}

      {/* Assistant preview */}
      {turn.assistantPreview && (
        <Section title="Assistant Response">
          <p className="leading-relaxed break-words whitespace-pre-wrap text-zinc-300">
            {turn.assistantPreview}
          </p>
        </Section>
      )}

      {/* Memory context */}
      {turn.memoryContext && (
        <Section title="Memory Context">
          <pre className="rounded bg-zinc-900 p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-zinc-400">
            {turn.memoryContext}
          </pre>
        </Section>
      )}

      {/* Tool calls */}
      {turn.toolCalls && turn.toolCalls.length > 0 && (
        <Section title={`Tool Calls (${String(turn.toolCalls.length)})`}>
          <div className="flex flex-col gap-1">
            {turn.toolCalls.map((tc, i) => (
              <div key={i} className="rounded bg-zinc-800 px-2 py-1">
                <span className="font-mono text-violet-300">{tc.name}</span>
                {tc.args != null && (
                  <pre className="mt-0.5 text-[10px] break-all whitespace-pre-wrap text-zinc-500">
                    {JSON.stringify(tc.args, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Dispatch ID */}
      {turn.dispatchId && <div className="mt-2 font-mono text-zinc-700">ID: {turn.dispatchId}</div>}

      {/* Replay CTA */}
      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={() => onReplayFrom(turn.seq)}
          className="w-full rounded-lg bg-blue-700 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600"
        >
          Re-run from Turn {turn.seq} →
        </button>
      </div>
    </div>
  );
};

export default TurnDetailPanel;
