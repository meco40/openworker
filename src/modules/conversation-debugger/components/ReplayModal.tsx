import React, { useEffect, useState } from 'react';

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

  if (!open) return null;

  const handleStart = async () => {
    await onStartReplay(selectedModel || undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop — close via Escape key or Cancel button */}
      <div aria-hidden="true" className="absolute inset-0" />

      <div className="relative z-10 w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 text-sm shadow-2xl">
        <h2 className="mb-1 text-base font-semibold text-zinc-100">Replay from Turn {fromSeq}</h2>
        <p className="mb-5 text-xs text-zinc-500">
          A new conversation will be created with the message history leading up to turn {fromSeq}.
          The original conversation is not modified.
        </p>

        {/* Model selector */}
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-zinc-400">Model override (optional)</span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-200 focus:border-blue-500 focus:outline-none"
            disabled={loading}
          >
            <option value="">Use original model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* Success */}
        {lastReplayConversationId && !error && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
            <span>✓ New conversation created</span>
            <button
              type="button"
              onClick={() => onOpenChat(lastReplayConversationId)}
              className="ml-3 rounded bg-emerald-700 px-2 py-0.5 text-white transition-colors hover:bg-emerald-600"
            >
              Open Chat →
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={loading || !!lastReplayConversationId}
            className="rounded-lg bg-blue-700 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
          >
            {loading ? 'Starting…' : 'Start Replay'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReplayModal;
