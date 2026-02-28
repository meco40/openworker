import React, { useCallback, useMemo, useState } from 'react';
import type { MasterRun, MasterRunStatus } from '@/modules/master/types';
import { RunStatusBadge } from './RunStatusBadge';

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set<MasterRunStatus>([
  'ANALYZING',
  'PLANNING',
  'DELEGATING',
  'EXECUTING',
  'VERIFYING',
  'REFINING',
  'AWAITING_APPROVAL',
]);

const ITEMS_PER_PAGE = 10;

type StatusFilter = 'all' | 'active' | 'done' | 'failed';

interface FilterChip {
  id: StatusFilter;
  label: string;
  count: number;
  baseStyle: string;
  activeStyle: string;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface RunListProps {
  runs: MasterRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const RunList: React.FC<RunListProps> = ({ runs, selectedRunId, onSelectRun }) => {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);

  // ── Derived counts for chips ────────────────────────────────────────────────

  const counts = useMemo(
    () => ({
      active: runs.filter((r) => ACTIVE_STATUSES.has(r.status)).length,
      done: runs.filter((r) => r.status === 'COMPLETED').length,
      failed: runs.filter((r) => r.status === 'FAILED').length,
    }),
    [runs],
  );

  const FILTER_CHIPS: FilterChip[] = [
    {
      id: 'all',
      label: 'All',
      count: runs.length,
      baseStyle:
        'border-zinc-800 bg-zinc-950/60 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300',
      activeStyle: 'border-zinc-600 bg-zinc-800 text-zinc-200',
    },
    {
      id: 'active',
      label: 'Active',
      count: counts.active,
      baseStyle:
        'border-emerald-900/60 bg-emerald-950/30 text-emerald-600 hover:border-emerald-700/50 hover:text-emerald-400',
      activeStyle: 'border-emerald-500/50 bg-emerald-900/20 text-emerald-300',
    },
    {
      id: 'done',
      label: 'Done',
      count: counts.done,
      baseStyle:
        'border-indigo-900/60 bg-indigo-950/30 text-indigo-500/70 hover:border-indigo-700/50 hover:text-indigo-300',
      activeStyle: 'border-indigo-500/50 bg-indigo-900/20 text-indigo-300',
    },
    {
      id: 'failed',
      label: 'Failed',
      count: counts.failed,
      baseStyle:
        'border-rose-900/60 bg-rose-950/30 text-rose-500/60 hover:border-rose-700/50 hover:text-rose-300',
      activeStyle: 'border-rose-500/50 bg-rose-900/20 text-rose-300',
    },
  ];

  // ── Filtering + pagination ──────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter((r) => {
      const matchesSearch = q ? r.title.toLowerCase().includes(q) : true;
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'active'
            ? ACTIVE_STATUSES.has(r.status)
            : statusFilter === 'done'
              ? r.status === 'COMPLETED'
              : r.status === 'FAILED';
      return matchesSearch && matchesStatus;
    });
  }, [runs, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const safePage = Math.min(page, totalPages - 1);
  const paginated = filtered.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  const handleFilterChange = (f: StatusFilter) => {
    setStatusFilter(f);
    setPage(0);
  };

  const handleSearch = (q: string) => {
    setSearch(q);
    setPage(0);
  };

  // ── Keyboard navigation ────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (paginated.length === 0) return;
      const currentIndex = paginated.findIndex((r) => r.id === selectedRunId);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(currentIndex + 1, paginated.length - 1);
        onSelectRun(paginated[next].id);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(currentIndex - 1, 0);
        onSelectRun(paginated[prev].id);
      }
    },
    [paginated, selectedRunId, onSelectRun],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  const isFiltered = search.trim() !== '' || statusFilter !== 'all';

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 shadow-xl">
      {/* ── Header ── */}
      <div className="border-b border-zinc-800/80 bg-zinc-950/40 px-6 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15">
            <svg
              className="h-3.5 w-3.5 text-emerald-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 10h16M4 14h16M4 18h16"
              />
            </svg>
          </div>
          <h3 className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">Runs</h3>
          <span className="ml-1 rounded-md border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-500">
            {runs.length}
          </span>
          {isFiltered && filtered.length !== runs.length && (
            <span className="rounded-md border border-indigo-800/60 bg-indigo-950/40 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-indigo-400">
              {filtered.length} shown
            </span>
          )}
        </div>
      </div>

      {/* ── Search + Filter bar (only when there are runs) ── */}
      {runs.length > 0 && (
        <div className="space-y-2.5 border-b border-zinc-800/60 bg-zinc-950/20 px-4 py-3">
          {/* Search input */}
          <div className="relative">
            <svg
              className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search contracts…"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900/80 py-1.5 pr-3 pl-7 text-xs text-zinc-200 placeholder-zinc-600 transition-colors outline-none focus:border-zinc-600 focus:ring-0"
              aria-label="Search runs by title"
            />
            {search && (
              <button
                type="button"
                onClick={() => handleSearch('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-600 transition-colors hover:text-zinc-400"
                aria-label="Clear search"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>

          {/* Status filter chips */}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                onClick={() => handleFilterChange(chip.id)}
                aria-pressed={statusFilter === chip.id}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] font-bold tracking-wide uppercase transition-all ${
                  statusFilter === chip.id ? chip.activeStyle : chip.baseStyle
                }`}
              >
                {chip.id === 'active' && chip.count > 0 && statusFilter === chip.id && (
                  <span
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"
                    aria-hidden="true"
                  />
                )}
                {chip.label}
                <span
                  className={`rounded-md px-1 py-0.5 font-mono text-[9px] ${
                    statusFilter === chip.id
                      ? 'bg-white/10 text-current'
                      : 'bg-zinc-800/80 text-zinc-600'
                  }`}
                >
                  {chip.count}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── List body ── */}
      <div className="p-4">
        {runs.length === 0 ? (
          // Global empty state (no runs at all)
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-10 text-center">
            <svg
              className="mb-3 h-10 w-10 text-zinc-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <p className="text-sm font-medium text-zinc-600">No runs yet</p>
            <p className="mt-1 text-xs text-zinc-700">Create your first Master Run above.</p>
          </div>
        ) : filtered.length === 0 ? (
          // Filter/search empty state
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800/60 bg-zinc-950/20 px-4 py-8 text-center">
            <svg
              className="mb-3 h-8 w-8 text-zinc-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <p className="text-sm font-medium text-zinc-600">No matches</p>
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setStatusFilter('all');
                setPage(0);
              }}
              className="mt-2 text-xs text-indigo-400 underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <>
            <div
              role="listbox"
              aria-label="Master runs"
              className="space-y-2"
              onKeyDown={handleKeyDown}
            >
              {paginated.map((run, index) => (
                <button
                  key={run.id}
                  type="button"
                  role="option"
                  aria-selected={selectedRunId === run.id}
                  tabIndex={
                    selectedRunId === run.id || (selectedRunId === null && index === 0) ? 0 : -1
                  }
                  onClick={() => onSelectRun(run.id)}
                  className={`w-full rounded-xl border p-3.5 text-left transition-all ${
                    selectedRunId === run.id
                      ? 'border-indigo-500/50 bg-indigo-900/20 shadow-lg shadow-indigo-900/10'
                      : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 hover:bg-zinc-900/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-zinc-100">
                      {run.title}
                    </span>
                    <RunStatusBadge status={run.status} />
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-zinc-500">{run.contract}</p>
                  {/* Progress bar */}
                  <div className="mt-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[9px] font-semibold tracking-wide text-zinc-600 uppercase">
                        Progress
                      </span>
                      <span className="font-mono text-[9px] font-semibold text-zinc-400">
                        {run.progress}%
                      </span>
                    </div>
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80"
                      role="progressbar"
                      aria-valuenow={run.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          run.status === 'FAILED'
                            ? 'bg-rose-500'
                            : run.status === 'CANCELLED'
                              ? 'bg-zinc-500'
                              : run.status === 'COMPLETED'
                                ? 'bg-indigo-500'
                                : 'bg-emerald-500'
                        }`}
                        style={{ width: `${run.progress}%` }}
                      />
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* ── Pagination ── */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                  disabled={safePage === 0}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-bold tracking-wide text-zinc-400 uppercase transition-all hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  ← Prev
                </button>
                <span className="font-mono text-[10px] text-zinc-500">
                  {safePage + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                  disabled={safePage >= totalPages - 1}
                  className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[10px] font-bold tracking-wide text-zinc-400 uppercase transition-all hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
