import React from 'react';
import type { MasterPersonaSummary, WorkspaceSummary } from '@/modules/master/types';

interface CreateRunFormProps {
  personas: MasterPersonaSummary[];
  workspaces: WorkspaceSummary[];
  selectedPersonaId: string;
  workspaceId: string;
  runTitle: string;
  runContract: string;
  loading: boolean;
  onPersonaChange: (id: string) => void;
  onWorkspaceChange: (id: string) => void;
  onTitleChange: (title: string) => void;
  onContractChange: (contract: string) => void;
  onCreateRun: () => void;
  onRefresh: () => void;
}

export const CreateRunForm: React.FC<CreateRunFormProps> = ({
  personas,
  workspaces,
  selectedPersonaId,
  workspaceId,
  runTitle,
  runContract,
  loading,
  onPersonaChange,
  onWorkspaceChange,
  onTitleChange,
  onContractChange,
  onCreateRun,
  onRefresh,
}) => {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h3 className="mb-4 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
        Create Master Run
      </h3>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5 text-xs text-zinc-400">
          <span>Persona</span>
          <select
            value={selectedPersonaId}
            onChange={(e) => onPersonaChange(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">Select persona</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.emoji ? `${p.emoji} ${p.name}` : p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5 text-xs text-zinc-400">
          <span>Workspace ID</span>
          {workspaces.length > 0 ? (
            <select
              value={workspaceId}
              onChange={(e) => onWorkspaceChange(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={workspaceId}
              onChange={(e) => onWorkspaceChange(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
              placeholder="main"
            />
          )}
        </label>
      </div>

      <label className="mt-3 block space-y-1.5 text-xs text-zinc-400">
        <span>Title</span>
        <input
          value={runTitle}
          onChange={(e) => onTitleChange(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
        />
      </label>

      <label className="mt-3 block space-y-1.5 text-xs text-zinc-400">
        <span>Contract</span>
        <textarea
          value={runContract}
          onChange={(e) => onContractChange(e.target.value)}
          rows={4}
          className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
          placeholder="Describe what Master should complete end-to-end."
        />
      </label>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCreateRun}
          disabled={loading || !runContract.trim()}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Working…' : 'Create Master Run'}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-xs font-bold text-zinc-200 transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
    </section>
  );
};
