import React, { useMemo, useState } from 'react';
import type { TaskPriority, TaskStatus } from '@/lib/types';
import {
  ALL_PRIORITIES,
  ALL_STATUSES,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_LABELS,
} from '@/modules/tasks/task-manager/constants';
import { CreateTaskModal } from '@/modules/tasks/task-manager/components/CreateTaskModal';
import { Spinner } from '@/modules/tasks/task-manager/components/Spinner';
import { TaskDetailPanel } from '@/modules/tasks/task-manager/components/TaskDetailPanel';
import { TaskRow } from '@/modules/tasks/task-manager/components/TaskRow';
import { useTaskCatalog } from '@/modules/tasks/task-manager/useTaskCatalog';

const TaskManagerView: React.FC = () => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [filterStatus, setFilterStatus] = useState<TaskStatus | ''>('');
  const [filterPriority, setFilterPriority] = useState<TaskPriority | ''>('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'updated_at' | 'created_at' | 'priority'>('updated_at');
  const {
    tasks,
    loading,
    error,
    pendingActions,
    loadTasks,
    handleCreated,
    handleDelete,
    handleStatusChange,
  } = useTaskCatalog(filterStatus);

  const filteredTasks = useMemo(() => {
    let result = tasks;
    if (filterPriority) result = result.filter((t) => t.priority === filterPriority);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q) ||
          (t.assigned_agent?.name ?? '').toLowerCase().includes(q),
      );
    }
    return [...result].sort((a, b) => {
      if (sortBy === 'priority') return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (sortBy === 'created_at')
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [tasks, filterPriority, search, sortBy]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  }, [tasks]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-900/40 text-violet-400"
            aria-hidden="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M2 4.5A2.5 2.5 0 014.5 2h11A2.5 2.5 0 0118 4.5v11a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 012 15.5v-11zm2.5-.5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM6 7.75A.75.75 0 016.75 7h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 016 7.75zm0 3.5A.75.75 0 016.75 10.5h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 016 11.25zm0 3.5A.75.75 0 016.75 14h4a.75.75 0 010 1.5h-4A.75.75 0 016 14.75z" />
            </svg>
          </span>
          <h1 className="text-sm font-semibold text-zinc-100">Task Manager</h1>
        </div>
        {!loading && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
            {filteredTasks.length}
            {filteredTasks.length !== tasks.length ? ` / ${String(tasks.length)}` : ''}
          </span>
        )}

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
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search tasks"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 py-1.5 pr-3 pl-8 text-xs text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
          />
        </div>

        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as TaskStatus | '')}
          aria-label="Filter by status"
          className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-300 focus:border-blue-500 focus:outline-none"
        >
          <option value="">All statuses</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
              {statusCounts[s] ? ` (${String(statusCounts[s])})` : ''}
            </option>
          ))}
        </select>

        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value as TaskPriority | '')}
          aria-label="Filter by priority"
          className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-300 focus:border-blue-500 focus:outline-none"
        >
          <option value="">All priorities</option>
          {ALL_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          aria-label="Sort by"
          className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-300 focus:border-blue-500 focus:outline-none"
        >
          <option value="updated_at">Sort: Recent</option>
          <option value="created_at">Sort: Created</option>
          <option value="priority">Sort: Priority</option>
        </select>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadTasks()}
            disabled={loading}
            aria-label="Refresh tasks"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z"
                clipRule="evenodd"
              />
            </svg>
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
            </svg>
            New Task
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {loading && tasks.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <Spinner size="md" />
              <span className="text-xs text-zinc-600">Loading tasks…</span>
            </div>
          )}
          {error && !loading && (
            <div className="m-4">
              <div
                className="flex items-start gap-2 rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-sm text-red-400"
                role="alert"
              >
                <span className="mt-px shrink-0 text-red-500" aria-hidden="true">
                  ⚠
                </span>
                <span className="flex-1">{error}</span>
                <button
                  type="button"
                  onClick={() => void loadTasks()}
                  className="shrink-0 underline hover:text-red-200"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
          {!loading && !error && filteredTasks.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <span className="text-4xl" aria-hidden="true">
                📋
              </span>
              <p className="text-sm font-medium text-zinc-500">
                {tasks.length === 0 ? 'No tasks yet' : 'No tasks match your filters'}
              </p>
              <p className="max-w-xs text-xs text-zinc-700">
                {tasks.length === 0
                  ? 'Create your first task to get started.'
                  : 'Try adjusting your search or filter criteria.'}
              </p>
              {tasks.length === 0 && (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="mt-1 rounded-lg bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  Create Task
                </button>
              )}
            </div>
          )}
          {filteredTasks.length > 0 && (
            <div className="flex-1 overflow-auto">
              <table className="w-full text-left">
                <thead className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950">
                  <tr>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                      Task
                    </th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                      Status
                    </th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                      Priority
                    </th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                      Assigned
                    </th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                      Due
                    </th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                      Updated
                    </th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      isSelected={selectedId === task.id}
                      onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
                      onStatusChange={handleStatusChange}
                      onDelete={(id) => handleDelete(id, selectedId, () => setSelectedId(null))}
                      pendingAction={pendingActions[task.id] ?? null}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            onClose={() => setSelectedId(null)}
            onStatusChange={handleStatusChange}
            pendingAction={pendingActions[selectedTask.id] ?? null}
          />
        )}
      </div>

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
};

export default TaskManagerView;
