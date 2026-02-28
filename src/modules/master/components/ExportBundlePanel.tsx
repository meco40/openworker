import React, { useCallback } from 'react';

interface ExportBundlePanelProps {
  exportBundle: string;
  onDismiss: () => void;
}

export const ExportBundlePanel: React.FC<ExportBundlePanelProps> = ({
  exportBundle,
  onDismiss,
}) => {
  const handleDownload = useCallback(() => {
    const blob = new Blob([exportBundle], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `master-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportBundle]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(exportBundle);
  }, [exportBundle]);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
          Export Bundle
        </h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-[10px] font-bold text-zinc-300 transition-all hover:bg-zinc-800 active:scale-95"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[10px] font-bold text-white transition-all hover:bg-indigo-500 active:scale-95"
          >
            Download
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-[10px] font-bold text-zinc-500 transition-all hover:bg-zinc-800 hover:text-zinc-300 active:scale-95"
            aria-label="Dismiss export bundle"
          >
            ✕
          </button>
        </div>
      </div>
      <pre className="max-h-72 overflow-auto rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-xs text-zinc-200">
        {exportBundle}
      </pre>
    </section>
  );
};
