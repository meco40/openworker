import React from 'react';
import type {
  MasterPersonaSummary,
  MasterViewMode,
  WorkspaceSummary,
} from '@/modules/master/types';

interface CreateRunFormProps {
  mode: MasterViewMode;
  persona: MasterPersonaSummary | null;
  personas: MasterPersonaSummary[];
  selectedPersonaId: string;
  workspaces: WorkspaceSummary[];
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
  mode,
  persona,
  personas,
  selectedPersonaId,
  workspaces,
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
  const workspaceControlId =
    workspaces.length > 0 ? 'create-run-workspace-select' : 'create-run-workspace-input';
  const personaSelectId = 'create-run-persona-select';
  const titleInputId = 'create-run-title-input';
  const contractTextareaId = 'create-run-contract-textarea';

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      {/* Section header */}
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
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
                d="M12 4v16m8-8H4"
              />
            </svg>
          </div>
          <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
            Create Master Run
          </h3>
        </div>
      </div>

      <div className="p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            {mode === 'system' ? (
              <>
                <span className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                  Persona
                </span>
                <div className="rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-3 text-sm text-zinc-100">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{persona?.emoji ?? '🧭'}</span>
                      <div>
                        <p className="font-semibold text-white">{persona?.name ?? 'Master'}</p>
                        <p className="text-xs text-zinc-500">System persona managed via Settings</p>
                      </div>
                    </div>
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold tracking-widest text-amber-300 uppercase">
                      Fixed
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <label
                  htmlFor={personaSelectId}
                  className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase"
                >
                  Persona
                </label>
                <select
                  id={personaSelectId}
                  value={selectedPersonaId}
                  onChange={(event) => onPersonaChange(event.target.value)}
                  className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 transition-colors focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
                >
                  <option value="">Select Persona</option>
                  {personas.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.emoji ?? '🤖'} {entry.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor={workspaceControlId}
              className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase"
            >
              Workspace
            </label>
            {workspaces.length > 0 ? (
              <select
                id={workspaceControlId}
                value={workspaceId}
                onChange={(e) => onWorkspaceChange(e.target.value)}
                className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 transition-colors focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={workspaceControlId}
                value={workspaceId}
                onChange={(e) => onWorkspaceChange(e.target.value)}
                className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 transition-colors focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
                placeholder="Default Workspace"
              />
            )}
          </div>
        </div>

        <div className="mt-4 space-y-1.5">
          <label
            htmlFor={titleInputId}
            className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase"
          >
            Title
          </label>
          <input
            id={titleInputId}
            value={runTitle}
            onChange={(e) => onTitleChange(e.target.value)}
            className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 transition-colors focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
          />
        </div>

        <div className="mt-4 space-y-1.5">
          <label
            htmlFor={contractTextareaId}
            className="block text-[11px] font-semibold tracking-wide text-zinc-500 uppercase"
          >
            Contract
          </label>
          <textarea
            id={contractTextareaId}
            value={runContract}
            onChange={(e) => onContractChange(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 transition-colors focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/30 focus:outline-none"
            placeholder="Describe what Master should complete end-to-end."
          />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onCreateRun}
            disabled={loading || !selectedPersonaId || !runContract.trim()}
            className="rounded-2xl bg-indigo-600 px-5 py-2.5 text-xs font-black tracking-widest text-white uppercase shadow-lg shadow-indigo-600/25 transition-all hover:bg-indigo-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <svg
                  className="h-3 w-3 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Working…
              </span>
            ) : (
              'Create Master Run'
            )}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-xs font-black tracking-widest text-zinc-300 uppercase transition-all hover:bg-zinc-800 hover:text-white active:scale-95 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
    </section>
  );
};
