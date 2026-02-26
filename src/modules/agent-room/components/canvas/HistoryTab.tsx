'use client';

interface HistoryTabProps {
  artifactHistory: string[];
}

export function HistoryTab({ artifactHistory }: HistoryTabProps) {
  if (!artifactHistory?.length) {
    return <p className="pt-6 text-center text-xs text-zinc-600">No history yet.</p>;
  }

  return (
    <div className="space-y-2">
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
            <div className="border-t border-zinc-800/50 px-2 py-1.5 text-[11px] whitespace-pre-wrap text-zinc-400">
              {delta || '(empty)'}
            </div>
          </details>
        );
      })}
    </div>
  );
}
