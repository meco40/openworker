import React from 'react';
import type { Task, TaskStatus } from '@/lib/types';
import { ALL_STATUSES, STATUS_COLORS, STATUS_LABELS } from '@/modules/tasks/task-manager/constants';
import { formatDate, formatRelative } from '@/modules/tasks/task-manager/dateFormat';
import { PriorityBadge } from '@/modules/tasks/task-manager/components/PriorityBadge';
import { StatusBadge } from '@/modules/tasks/task-manager/components/StatusBadge';

interface TaskDetailPanelProps {
  task: Task;
  onClose: () => void;
  onStatusChange: (id: string, status: TaskStatus) => Promise<void>;
  pendingAction: string | null;
}

export const TaskDetailPanel: React.FC<TaskDetailPanelProps> = ({
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
        <span className="text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
          Task Detail
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
        <h3 className="mb-3 text-sm leading-snug font-semibold text-zinc-100">{task.title}</h3>
        <div className="mb-4 flex flex-wrap gap-2">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
        </div>
        {task.description && (
          <div className="mb-4">
            <p className="mb-1 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">
              Description
            </p>
            <p className="text-xs leading-relaxed whitespace-pre-wrap text-zinc-400">
              {task.description}
            </p>
          </div>
        )}
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

        <div className="mb-4">
          <p className="mb-1.5 text-[10px] font-semibold tracking-wider text-zinc-600 uppercase">
            Move to
          </p>
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
