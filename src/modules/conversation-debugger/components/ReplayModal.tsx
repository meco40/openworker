import React, { useEffect, useRef, useState } from 'react';
import { Spinner, ErrorBanner } from './ui-helpers';

interface PipelineOption {
  id: string;
  name: string;
}

interface ReplayModalProps {
  fromSeq: number | null;
  open: boolean;
  loading: boolean;
  error: string | null;
  lastReplayConversationId: string | null;
  onStartReplay: (modelOverride?: string) => Promise<string | null>;
  onClose: () => void;
  onOpenChat: (conversationId: string) => void;
}

const ReplayModal: React.FC<ReplayModalProps> = ({
  fromSeq,
  open,
  loading,
  error,
  lastReplayConversationId,
  onStartReplay,
  onClose,
  onOpenChat,
}) => {
  const [models, setModels] = useState<PipelineOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);

  // Load pipeline options when modal opens
  useEffect(() => {
    if (!open) return;
    fetch('/api/model-hub/pipeline')
      .then((r) => r.json() as Promise<{ ok: boolean; pipelines?: PipelineOption[] }>)
      .then((data) => {
        if (data.ok && Array.isArray(data.pipelines)) {
          setModels(data.pipelines);
        }
      })
      .catch(() => {
        /* non-blocking */
      });
  }, [open]);

  // Focus trap: focus first element when modal opens
  useEffect(() => {
    if (open) {
      setTimeout(() => firstFocusRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const handleStart = async () => {
    await onStartReplay(selectedModel || undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const succeeded = !!lastReplayConversationId && !error;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="replay-modal-title"
      aria-describedby="replay-modal-desc"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog panel */}
      <div
        ref={dialogRef}
        className="relative z-10 w-full max-w-md rounded-xl border border-zinc-700/60 bg-zinc-900 shadow-2xl shadow-black/60"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h2 id="replay-modal-title" className="text-sm font-semibold text-zinc-100">
              Replay from Turn {fromSeq}
            </h2>
            <p id="replay-modal-desc" className="mt-0.5 text-xs text-zinc-500">
              Creates a new conversation with history up to turn {fromSeq}. The original is
              unchanged.
            </p>
          </div>
          <button
            ref={firstFocusRef}
            type="button"
            onClick={onClose}
            aria-label="Close replay modal"
            className="ml-4 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {/* Model selector */}
          <label className="mb-4 block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">
              Model override <span className="font-normal text-zinc-600">(optional)</span>
            </span>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={loading || succeeded}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-200 transition-colors focus:border-blue-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">Use original model</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          {/* Error state */}
          {error && (
            <div className="mb-4">
              <ErrorBanner message={error} />
            </div>
          )}

          {/* Success state */}
          {succeeded && (
            <div className="mb-4 rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-4 py-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-emerald-300">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4 shrink-0"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
                    clipRule="evenodd"
                  />
                </svg>
                New conversation created
              </div>
              <p className="mb-3 font-mono text-[10px] break-all text-emerald-600">
                {lastReplayConversationId}
              </p>
              <button
                type="button"
                onClick={() => onOpenChat(lastReplayConversationId!)}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-3.5 w-3.5"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M3 4.25A2.25 2.25 0 015.25 2h5.5A2.25 2.25 0 0113 4.25v2a.75.75 0 01-1.5 0v-2a.75.75 0 00-.75-.75h-5.5a.75.75 0 00-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 00.75-.75v-2a.75.75 0 011.5 0v2A2.25 2.25 0 0110.75 18h-5.5A2.25 2.25 0 013 15.75V4.25z"
                    clipRule="evenodd"
                  />
                  <path
                    fillRule="evenodd"
                    d="M19 10a.75.75 0 00-.75-.75H8.704l1.048-.943a.75.75 0 10-1.004-1.114l-2.5 2.25a.75.75 0 000 1.114l2.5 2.25a.75.75 0 101.004-1.114l-1.048-.943h9.546A.75.75 0 0019 10z"
                    clipRule="evenodd"
                  />
                </svg>
                Open in Chat
              </button>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {succeeded ? 'Close' : 'Cancel'}
          </button>

          {!succeeded && (
            <button
              type="button"
              onClick={handleStart}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Spinner size="sm" />
                  Starting…
                </>
              ) : (
                <>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M2 10a8 8 0 1116 0 8 8 0 01-16 0zm6.39-2.908a.75.75 0 01.766.027l3.5 2.25a.75.75 0 010 1.262l-3.5 2.25A.75.75 0 018 12.25v-4.5a.75.75 0 01.39-.658z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Start Replay
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReplayModal;
