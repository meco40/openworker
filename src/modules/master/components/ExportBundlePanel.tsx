import React, { useCallback, useState } from 'react';

interface ExportBundlePanelProps {
  exportBundle: string;
  runId: string;
  onDismiss: () => void;
}

export const ExportBundlePanel: React.FC<ExportBundlePanelProps> = ({
  exportBundle,
  runId,
  onDismiss,
}) => {
  const [copied, setCopied] = useState(false);

  const handleDownload = useCallback(() => {
    const blob = new Blob([exportBundle], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `master-export-${runId}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportBundle, runId]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(exportBundle);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — silently ignore
    }
  }, [exportBundle]);

  return (
    <section className="overflow-hidden rounded-2xl border border-indigo-500/30 bg-zinc-900/40 shadow-xl shadow-indigo-900/10">
      {/* Header */}
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500/15">
              <svg
                className="h-3.5 w-3.5 text-indigo-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
            </div>
            <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
              Export Bundle
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[10px] font-bold tracking-wide text-zinc-300 uppercase transition-all hover:bg-zinc-800 hover:text-white active:scale-95"
            >
              {copied ? (
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.5}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  Copied
                </span>
              ) : (
                'Copy'
              )}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-xl bg-indigo-600 px-3 py-1.5 text-[10px] font-bold tracking-wide text-white uppercase transition-all hover:bg-indigo-500 active:scale-95"
            >
              Download
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-300 active:scale-95"
              aria-label="Dismiss export bundle"
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
        </div>
      </div>
      <div className="p-4">
        <pre className="max-h-72 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/80 p-4 font-mono text-xs leading-relaxed text-zinc-300">
          {exportBundle}
        </pre>
      </div>
    </section>
  );
};
