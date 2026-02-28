'use client';

import React, { useState } from 'react';
import { useOpsAgents } from '@/modules/ops/hooks/useOpsAgents';
import type { OpsAgentPersonaSummary } from '@/modules/ops/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(value: string | null): string {
  if (!value) return 'n/a';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const diff = Date.now() - parsed;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

function formatDateTime(value: string | null): string {
  if (!value) return 'n/a';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const Spinner: React.FC = () => (
  <svg
    className="h-5 w-5 animate-spin text-zinc-400"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
    />
  </svg>
);

// ─── Persona Card ─────────────────────────────────────────────────────────────

interface PersonaCardProps {
  persona: OpsAgentPersonaSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

const PersonaCard: React.FC<PersonaCardProps> = ({ persona, isSelected, onSelect }) => {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      aria-label={`Agent: ${persona.name}`}
      onClick={() => onSelect(persona.id)}
      className={`group cursor-pointer rounded-xl border p-4 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        isSelected
          ? 'border-blue-600/60 bg-blue-950/25 shadow-sm shadow-blue-900/20'
          : 'border-zinc-800/60 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-800/30'
      }`}
    >
      {/* Header: emoji + name */}
      <div className="mb-2 flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-xl"
          aria-hidden="true"
        >
          {persona.emoji || '🤖'}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={`truncate text-sm leading-snug font-semibold ${
              isSelected ? 'text-blue-200' : 'text-zinc-100'
            }`}
          >
            {persona.name}
          </p>
          {persona.vibe && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-500">
              {persona.vibe}
            </p>
          )}
          {!persona.vibe && <p className="mt-0.5 text-xs text-zinc-700 italic">No vibe set</p>}
        </div>
      </div>

      {/* Footer: last updated */}
      <div className="flex items-center justify-between border-t border-zinc-800/50 pt-2">
        <span className="text-[10px] text-zinc-600">
          Updated{' '}
          <span title={formatDateTime(persona.updatedAt)}>
            {formatRelativeTime(persona.updatedAt)}
          </span>
        </span>
        <span
          className={`text-[10px] font-medium transition-opacity ${
            isSelected
              ? 'text-blue-400 opacity-100'
              : 'text-zinc-700 opacity-0 group-hover:opacity-100'
          }`}
          aria-hidden="true"
        >
          {isSelected ? '● Selected' : 'View →'}
        </span>
      </div>
    </button>
  );
};

// ─── Persona Detail Panel ─────────────────────────────────────────────────────

interface PersonaDetailPanelProps {
  persona: OpsAgentPersonaSummary;
  onClose: () => void;
}

const PersonaDetailPanel: React.FC<PersonaDetailPanelProps> = ({ persona, onClose }) => (
  <aside
    aria-label={`Agent detail: ${persona.name}`}
    className="flex w-72 shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-900/80"
  >
    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
      <span className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
        Agent Detail
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close detail panel"
        className="flex h-6 w-6 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
      >
        ×
      </button>
    </div>

    <div className="flex-1 overflow-auto px-4 py-4">
      {/* Avatar + name */}
      <div className="mb-4 flex items-center gap-3">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 text-2xl"
          aria-hidden="true"
        >
          {persona.emoji || '🤖'}
        </span>
        <div>
          <p className="text-sm font-semibold text-zinc-100">{persona.name}</p>
          <p className="font-mono text-[11px] text-zinc-600">{persona.id.slice(0, 12)}…</p>
        </div>
      </div>

      {/* Vibe */}
      {persona.vibe && (
        <div className="mb-4">
          <p className="mb-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">
            Vibe
          </p>
          <p className="text-xs leading-relaxed text-zinc-400">{persona.vibe}</p>
        </div>
      )}

      {/* Metadata */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-600">Last updated</span>
            <span className="text-[11px] text-zinc-300" title={formatDateTime(persona.updatedAt)}>
              {formatRelativeTime(persona.updatedAt)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-600">ID</span>
            <span className="font-mono text-[10px] text-zinc-700">{persona.id.slice(0, 8)}…</span>
          </div>
        </div>
      </div>
    </div>
  </aside>
);

// ─── Main Component ───────────────────────────────────────────────────────────

const AgentsView: React.FC = () => {
  const state = useOpsAgents();
  const personas = state.data?.agents.personas ?? [];
  const generatedAt = state.data?.agents.generatedAt ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filteredPersonas = search.trim()
    ? personas.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          (p.vibe ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : personas;

  const selectedPersona = personas.find((p) => p.id === selectedId) ?? null;

  const handleSelect = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-3">
        {/* Title */}
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-900/40 text-blue-400"
            aria-hidden="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M10 9a3 3 0 100-6 3 3 0 000 6zM6 8a2 2 0 11-4 0 2 2 0 014 0zM1.49 15.326a.78.78 0 01-.358-.442 3 3 0 014.308-3.516 6.484 6.484 0 00-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 01-2.07-.655zM16.44 15.98a4.97 4.97 0 002.07-.654.78.78 0 00.357-.442 3 3 0 00-4.308-3.517 6.484 6.484 0 011.907 3.96 2.32 2.32 0 01-.026.654zM18 8a2 2 0 11-4 0 2 2 0 014 0zM5.304 16.19a.844.844 0 01-.277-.71 5 5 0 019.947 0 .843.843 0 01-.277.71A6.975 6.975 0 0110 18a6.974 6.974 0 01-4.696-1.81z" />
            </svg>
          </span>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Agents</h2>
            <p className="text-xs text-zinc-500">Persona snapshots for active agent operations.</p>
          </div>
        </div>

        {/* Count chip */}
        {!state.loading && personas.length > 0 && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
            {filteredPersonas.length}
            {filteredPersonas.length !== personas.length ? ` / ${String(personas.length)}` : ''}
          </span>
        )}

        {/* Search */}
        {personas.length > 0 && (
          <div className="relative flex-1 sm:max-w-xs">
            <span
              className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-600"
              aria-hidden="true"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-3.5 w-3.5"
              >
                <path
                  fillRule="evenodd"
                  d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                  clipRule="evenodd"
                />
              </svg>
            </span>
            <input
              type="search"
              placeholder="Search agents…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search agents"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 py-1.5 pr-3 pl-8 text-xs text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
            />
          </div>
        )}

        {/* Generated at */}
        {generatedAt && (
          <span
            className="hidden text-[10px] text-zinc-700 sm:block"
            title={formatDateTime(generatedAt)}
          >
            Snapshot: {formatRelativeTime(generatedAt)}
          </span>
        )}

        {/* Refresh */}
        <button
          type="button"
          onClick={() => void state.refresh()}
          disabled={state.loading || state.refreshing}
          aria-label="Refresh agents"
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-3.5 w-3.5 ${state.refreshing ? 'animate-spin' : ''}`}
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z"
              clipRule="evenodd"
            />
          </svg>
          {state.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Main content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Error */}
          {state.error && (
            <div className="m-4">
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-sm text-red-400"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="mt-px h-4 w-4 shrink-0 text-red-500"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
                    clipRule="evenodd"
                  />
                </svg>
                <span className="flex-1">{state.error}</span>
                <button
                  type="button"
                  onClick={() => void state.refresh()}
                  className="shrink-0 underline hover:text-red-200 focus:outline-none"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Loading */}
          {state.loading && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <Spinner />
              <span className="text-xs text-zinc-600">Loading agent runtime snapshot...</span>
            </div>
          )}

          {/* Empty */}
          {!state.loading && !state.error && personas.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <span className="text-4xl" aria-hidden="true">
                🤖
              </span>
              <p className="text-sm font-medium text-zinc-500">No personas found for this user.</p>
              <p className="max-w-xs text-xs text-zinc-700">
                No persona snapshots are available. Create a persona to get started.
              </p>
            </div>
          )}

          {/* Filtered empty */}
          {!state.loading &&
            !state.error &&
            personas.length > 0 &&
            filteredPersonas.length === 0 && (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm font-medium text-zinc-500">No agents match your search</p>
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="text-xs text-zinc-600 underline hover:text-zinc-400"
                >
                  Clear search
                </button>
              </div>
            )}

          {/* Agent grid */}
          {!state.loading && filteredPersonas.length > 0 && (
            <div className="flex-1 overflow-auto p-4">
              <div
                role="list"
                aria-label="Agent personas"
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              >
                {filteredPersonas.map((persona) => (
                  <div key={persona.id} role="listitem">
                    <PersonaCard
                      persona={persona}
                      isSelected={selectedId === persona.id}
                      onSelect={handleSelect}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedPersona && (
          <PersonaDetailPanel persona={selectedPersona} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </div>
  );
};

export default AgentsView;
