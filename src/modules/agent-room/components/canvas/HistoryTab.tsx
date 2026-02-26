'use client';

import { useState } from 'react';
import { computeLineDiff, type DiffLine } from '@/shared/lib/lineDiff';
import { InlineMarkdown } from '@/modules/agent-room/components/InlineMarkdown';

interface HistoryTabProps {
  artifactHistory: string[];
}

const DIFF_COLOURS: Record<DiffLine['kind'], string> = {
  added: 'bg-emerald-900/40 text-emerald-300',
  removed: 'bg-red-900/40 text-red-400 line-through',
  same: 'text-zinc-500',
};

const DIFF_PREFIX: Record<DiffLine['kind'], string> = {
  added: '+',
  removed: '−',
  same: ' ',
};

/**
 * Strip leading **[Name]:** or **Name:** speaker marker so inline headings
 * (e.g. `### Title`) at the start of a turn render as proper headings.
 */
function stripLeadingSpeaker(text: string): string {
  return text.replace(/^\*\*\[?[^\]\n*]+?\]?\s*(?::\*\*|\*\*\s*:)\s*/, '');
}

export function HistoryTab({ artifactHistory }: HistoryTabProps) {
  const [viewMode, setViewMode] = useState<'rendered' | 'diff' | 'raw'>('rendered');

  if (!artifactHistory?.length) {
    return <p className="pt-6 text-center text-xs text-zinc-600">No history yet.</p>;
  }

  return (
    <div className="space-y-2">
      {/* View mode toggle */}
      <div className="flex items-center justify-end gap-1 px-1">
        {(['rendered', 'diff', 'raw'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setViewMode(mode)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              viewMode === mode
                ? 'bg-indigo-500/30 text-indigo-200'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            {mode === 'rendered' ? 'Rendered' : mode === 'diff' ? 'Diff' : 'Raw'}
          </button>
        ))}
      </div>

      {artifactHistory.map((entry, i, arr) => {
        const prev = i > 0 ? arr[i - 1] : '';
        const delta = entry.startsWith(prev) ? entry.slice(prev.length).trim() : entry.trim();
        const speakerMatch = delta.match(/^\*\*\[([^\]]+)\]:\*\*/);
        const label = speakerMatch ? `Turn ${i + 1} — ${speakerMatch[1]}` : `Turn ${i + 1}`;

        return (
          <details
            key={`${i}-${entry.slice(0, 12)}`}
            className="rounded border border-zinc-800 bg-zinc-950/40"
            open={i >= arr.length - 3}
          >
            <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-semibold text-zinc-300 select-none hover:text-zinc-100">
              {label}
            </summary>

            {viewMode === 'diff' && i > 0 ? (
              <DiffView oldText={prev} newText={entry} />
            ) : viewMode === 'rendered' ? (
              <div className="border-t border-zinc-800/50 px-2 py-1.5">
                <InlineMarkdown
                  text={stripLeadingSpeaker(delta) || '(empty)'}
                  className="text-[11px] leading-relaxed text-zinc-300"
                />
              </div>
            ) : (
              <div className="border-t border-zinc-800/50 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-zinc-400">
                {delta || '(empty)'}
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}

/* ── Inline diff sub-component ── */

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = computeLineDiff(oldText, newText);

  // Only show lines that changed (+ a few context lines)
  const CONTEXT = 2;
  const shown = markVisibleLines(lines, CONTEXT);

  return (
    <div className="overflow-x-auto border-t border-zinc-800/50 px-1 py-1 font-mono text-[11px] leading-relaxed">
      {lines.map((line: DiffLine, idx: number) => {
        if (!shown[idx]) return null;
        return (
          <div key={idx} className={`rounded-sm px-1 ${DIFF_COLOURS[line.kind]}`}>
            <span className="inline-block w-4 opacity-60 select-none">
              {DIFF_PREFIX[line.kind]}
            </span>
            {line.text || '\u00A0'}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Mark which lines to show: all added/removed lines plus `ctx` context
 * lines of unchanged text around each change.
 */
function markVisibleLines(lines: DiffLine[], ctx: number): boolean[] {
  const visible = new Array(lines.length).fill(false) as boolean[];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'same') {
      const lo = Math.max(0, i - ctx);
      const hi = Math.min(lines.length - 1, i + ctx);
      for (let j = lo; j <= hi; j++) visible[j] = true;
    }
  }

  return visible;
}
