/**
 * TaskManagerView — modernized task management UI.
 * Fetches real data from /api/tasks; supports create, update status, delete.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task, TaskStatus, TaskPriority } from '@/lib/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_STATUSES: TaskStatus[] = [
  'inbox',
  'pending_dispatch',
  'planning',
  'assigned',
  'in_progress',
  'testing',
  'review',
  'done',
];

const ALL_PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];

const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  pending_dispatch: 'Pending',
  planning: 'Planning',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  testing: 'Testing',
  review: 'Review',
  done: 'Done',
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  inbox: 'bg-zinc-700/60 text-zinc-300',
  pending_dispatch: 'bg-amber-900/50 text-amber-300',
  planning: 'bg-blue-900/50 text-blue-300',
  assigned: 'bg-indigo-900/50 text-indigo-300',
  in_progress: 'bg-violet-900/50 text-violet-300',
  testing: 'bg-cyan-900/50 text-cyan-300',
  review: 'bg-orange-900/50 text-orange-300',
  done: 'bg-emerald-900/50 text-emerald-300',
};

const STATUS_DOT: Record<TaskStatus, string> = {
  inbox: 'bg-zinc-500',
  pending_dispatch: 'bg-amber-400',
  planning: 'bg-blue-400',
  assigned: 'bg-indigo-400',
  in_progress: 'bg-violet-400 animate-pulse',
  testing: 'bg-cyan-400',
  review: 'bg-orange-400',
  done: 'bg-emerald-500',
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  urgent: 'bg-red-900/60 text-red-300',
  high: 'bg-orange-900/50 text-orange-300',
  normal: 'bg-zinc-700/60 text-zinc-400',
  low: 'bg-zinc-800/60 text-zinc-600',
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: '🔴 Urgent',
  high: '🟠 High',
  normal: '⚪ Normal',
  low: '🔵 Low',
};

// ─── Small UI Helpers ─────────────────────────────────────────────────────────

const Spinner: React.FC<{ size?: 'sm' | 'md' }> = ({ size = 'md' }) => (
  <svg
    className={`animate-spin text-zinc-400 ${size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5'}`}
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

const StatusBadge: React.FC<{ status: TaskStatus }> = ({ status }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[status]}`}
  >
    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
    {STATUS_LABELS[status]}
  </span>
);

const PriorityBadge: React.FC<{ priority: TaskPriority }> = ({ priority }) => (
  <span
    className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_COLORS[priority]}`}
  >
    {PRIORITY_LABELS[priority]}
  </span>
);

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

// ─── Create Task Modal ────────────────────────────────────────────────────────

interface CreateTaskModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
}

const CreateTaskModal: React.FC<CreateTaskModalProps> = ({ open, onClose, onCreated }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setPriority('normal');
      setError(null);
      setTimeout(() => titleRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined, priority }),
      });
      const data = (await res.json()) as Task & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create task');
      onCreated(data);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-task-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div aria-hidden="true" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-zinc-700/60 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h2 id="create-task-title" className="text-sm font-semibold text-zinc-100">New Task</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            ×
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4">
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-zinc-400">Title <span className="text-red-500">*</span></span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
            />
          </label>
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-zinc-400">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details…"
              rows={3}
              className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
            />
          </label>
          <label className="mb-4 block">
            <span className="mb-1 block text-xs font-medium text-zinc-400">Priority</span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
            >
              {ALL_PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
              ))}
            </select>
          </label>
          {error && (
            <div className="mb-3 rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs text-red-400" role="alert">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title.trim()}
              className="flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-xs font-medium text-white hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
            >
              {loading && <Spinner size="sm" />}
              Create Task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ─── Task Row ─────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: Task;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onStatusChange: (id: string, status: TaskStatus) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  pendingAction: string | null;
}

const TaskRow: React.FC<TaskRowProps> = ({
  task,
  isSelected,
  onSelect,
  onStatusChange,
  onDelete,
  pendingAction,
}) => {
  const isPending = pendingAction !== null;

  return (
    <tr
      className={`border-b border-zinc-800/50 transition-colors ${
        isSelected ? 'bg-blue-950/20' : 'hover:bg-zinc-800/20'
      } ${isPending ? 'opacity-60' : ''}`}
    >
      {/* Title + description */}
      <td className="px-4 py-3">
        <button
          type="button"
          onClick={() => onSelect(task.id)}
          className="group text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
        >
          <p className={`text-sm font-medium leading-snug ${isSelected ? 'text-blue-300' : 'text-zinc-200 group-hover:text-zinc-100'}`}>
            {task.title}
          </p>
          {task.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-zinc-600">{task.description}</p>
          )}
        </button>
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        <select
          value={task.status}
          onChange={(e) => void onStatusChange(task.id, e.target.value as TaskStatus)}
          disabled={isPending}
          aria-label={`Status for ${task.title}`}
          className="rounded-full border-0 bg-transparent p-0 text-[10px] focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:cursor-not-allowed"
        >
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <div className="mt-0.5">
          <StatusBadge status={task.status} />
        </div>
      </td>

      {/* Priority */}
      <td className="px-4 py-3">
        <PriorityBadge priority={task.priority} />
      </td>

      {/* Assigned agent */}
      <td className="px-4 py-3">
        {task.assigned_agent ? (
          <span className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="text-base leading-none" aria-hidden="true">
              {task.assigned_agent.avatar_emoji ?? '🤖'}
            </span>
            <span className="truncate max-w-[100px]">{task.assigned_agent.name ?? 'Agent'}</span>
          </span>
        ) : (
          <span className="text-xs text-zinc-700">—</span>
        )}
      </td>

      {/* Due date */}
      <td className="px-4 py-3">
        {task.due_date ? (
          <span className="text-xs text-zinc-500" title={task.due_date}>
            {formatDate(task.due_date)}
          </span>
        ) : (
          <span className="text-xs text-zinc-700">—</span>
        )}
      </td>

      {/* Updated */}
      <td className="px-4 py-3">
        <span className="text-xs text-zinc-600" title={task.updated_at}>
          {formatRelative(task.updated_at)}
        </span>
      </td>

      {/* Actions */}
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          {isPending && <Spinner size="sm" />}
          {task.status !== 'done' && (
            <button
              type="button"
              onClick={() => void onStatusChange(task.id, 'done')}
              disabled={isPending}
              aria-label={`Mark "${task.title}" as done`}
              title="Mark done"
              className="rounded p-1 text-zinc-600 transition-colors hover:bg-emerald-900/30 hover:text-emerald-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={() => void onDelete(task.id)}
            disabled={isPending}
            aria-label={`Delete "${task.title}"`}
            title="Delete task"
            className="rounded p-1 text-zinc-700 transition-colors hover:bg-red-900/30 hover:text-red-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </td>
    </tr>
  );
};

// ─── Task Detail Panel ────────────────────────────────────────────────────────

interface TaskDetailPanelProps {
  task: Task;
  onClose: () => void;
  onStatusChange: (id: string, status: TaskStatus) => Promise<void>;
  pendingAction: string | null;
}

const TaskDetailPanel: React.FC<TaskDetailPanelProps> = ({
  task,
  onClose,
  onStatusChange,
  pendingAction,
}) => {
  const isPending = pendingAction !== null;

  return (
    <aside
      aria-label="Task detail"
      className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-900/80"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <span className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Task Detail</span>
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
        {/* Title */}
        <h3 className="mb-3 text-sm font-semibold leading-snug text-zinc-100">{task.title}</h3>

        {/* Badges */}
        <div className="mb-4 flex flex-wrap gap-2">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
        </div>

        {/* Description */}
        {task.description && (
          <div className="mb-4">
            <p className="mb-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">Description</p>
            <p className="text-xs leading-relaxed text-zinc-400 whitespace-pre-wrap">{task.description}</p>
          </div>
        )}

        {/* Meta */}
        <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
          <div className="flex flex-col gap-1.5">
            {task.assigned_agent && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-600">Assigned to</span>
                <span className="flex items-center gap-1 text-[11px] text-zinc-300">
                  <span aria-hidden="true">{task.assigned_agent.avatar_emoji ?? '🤖'}</span>
                  {task.assigned_agent.name ?? 'Agent'}
                </span>
              </div>
            )}
            {task.due_date && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-600">Due</span>
                <span className="text-[11px] text-zinc-300">{formatDate(task.due_date)}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-600">Created</span>
              <span className="text-[11px] text-zinc-500">{formatRelative(task.created_at)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-600">Updated</span>
              <span className="text-[11px] text-zinc-500">{formatRelative(task.updated_at)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-600">ID</span>
              <span className="font-mono text-[10px] text-zinc-700">{task.id.slice(0, 8)}…</span>
            </div>
          </div>
        </div>

        {/* Status change */}
        <div className="mb-4">
          <p className="mb-1.5 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">Move to</p>
          <div className="flex flex-wrap gap-1.5">
            {ALL_STATUSES.filter((s) => s !== task.status).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void onStatusChange(task.id, s)}
                disabled={isPending}
                className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${STATUS_COLORS[s]} hover:opacity-80`}
              >
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

const TaskManagerView: React.FC = () => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, string>>({});

  // Filters
  const [filterStatus, setFilterStatus] = useState<TaskStatus | ''>('');
  const [filterPriority, setFilterPriority] = useState<TaskPriority | ''>('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'updated_at' | 'created_at' | 'priority'>('updated_at');

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      const url = `/api/tasks${params.toString() ? `?${params.toString()}` : ''}`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to load tasks');
      }
      const data = (await res.json()) as Task[];
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const handleStatusChange = useCallback(async (id: string, status: TaskStatus) => {
    setPendingActions((prev) => ({ ...prev, [id]: 'status' }));
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to update task');
      }
      const updated = (await res.json()) as Task;
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
    } catch {
      // Silently reload on error
      void loadTasks();
    } finally {
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, [loadTasks]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this task? This cannot be undone.')) return;
    setPendingActions((prev) => ({ ...prev, [id]: 'delete' }));
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Failed to delete task');
      }
      setTasks((prev) => prev.filter((t) => t.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch {
      void loadTasks();
    } finally {
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, [loadTasks, selectedId]);

  const handleCreated = useCallback((task: Task) => {
    setTasks((prev) => [task, ...prev]);
  }, []);

  // Priority sort order
  const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

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
      if (sortBy === 'created_at') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [tasks, filterPriority, search, sortBy]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  // Summary counts
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  }, [tasks]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-900/40 text-violet-400" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M2 4.5A2.5 2.5 0 014.5 2h11A2.5 2.5 0 0118 4.5v11a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 012 15.5v-11zm2.5-.5a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM6 7.75A.75.75 0 016.75 7h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 016 7.75zm0 3.5A.75.75 0 016.75 10.5h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 016 11.25zm0 3.5A.75.75 0 016.75 14h4a.75.75 0 010 1.5h-4A.75.75 0 016 14.75z" />
            </svg>
          </span>
          <h1 className="text-sm font-semibold text-zinc-100">Task Manager</h1>
        </div>

        {/* Task count */}
        {!loading && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
            {filteredTasks.length}{filteredTasks.length !== tasks.length ? ` / ${String(tasks.length)}` : ''}
          </span>
        )}

        {/* Search */}
        <div className="relative flex-1 sm:max-w-xs">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-600" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
            </svg>
          </span>
          <input
            type="search"
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search tasks"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/60 py-1.5 pl-8 pr-3 text-xs text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
          />
        </div>

        {/* Filters */}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as TaskStatus | '')}
          aria-label="Filter by status"
          className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-300 focus:border-blue-500 focus:outline-none"
        >
          <option value="">All statuses</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}{statusCounts[s] ? ` (${String(statusCounts[s])})` : ''}
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
            <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
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

        {/* Actions */}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadTasks()}
            disabled={loading}
            aria-label="Refresh tasks"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true">
              <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
            </svg>
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
            </svg>
            New Task
          </button>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Main table area */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Loading */}
          {loading && tasks.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <Spinner size="md" />
              <span className="text-xs text-zinc-600">Loading tasks…</span>
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="m-4">
              <div className="flex items-start gap-2 rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-sm text-red-400" role="alert">
                <span className="mt-px shrink-0 text-red-500" aria-hidden="true">⚠</span>
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

          {/* Empty state */}
          {!loading && !error && filteredTasks.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <span className="text-4xl" aria-hidden="true">📋</span>
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

          {/* Task table */}
          {filteredTasks.length > 0 && (
            <div className="flex-1 overflow-auto">
              <table className="w-full text-left">
                <thead className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950">
                  <tr>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Task</th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Status</th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Priority</th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Assigned</th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Due</th>
                    <th className="px-4 py-2.5 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Updated</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">Actions</th>
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
                      onDelete={handleDelete}
                      pendingAction={pendingActions[task.id] ?? null}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedTask && (
          <TaskDetailPanel
            task={selectedTask}
            onClose={() => setSelectedId(null)}
            onStatusChange={handleStatusChange}
            pendingAction={pendingActions[selectedTask.id] ?? null}
          />
        )}
      </div>

      {/* ── Create Modal ─────────────────────────────────────────────────── */}
      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
};

export default TaskManagerView;
