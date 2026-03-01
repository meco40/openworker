import React from 'react';
import type { Task, TaskStatus } from '@/lib/types';
import { ALL_STATUSES, STATUS_LABELS } from '@/modules/tasks/task-manager/constants';
import { formatDate, formatRelative } from '@/modules/tasks/task-manager/dateFormat';
import { PriorityBadge } from '@/modules/tasks/task-manager/components/PriorityBadge';
import { Spinner } from '@/modules/tasks/task-manager/components/Spinner';
import { StatusBadge } from '@/modules/tasks/task-manager/components/StatusBadge';

interface TaskRowProps {
  task: Task;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onStatusChange: (id: string, status: TaskStatus) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  pendingAction: string | null;
}

export const TaskRow: React.FC<TaskRowProps> = ({
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
      <td className="px-4 py-3">
        <button
          type="button"
          onClick={() => onSelect(task.id)}
          className="group text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
        >
          <p
            className={`text-sm leading-snug font-medium ${
              isSelected ? 'text-blue-300' : 'text-zinc-200 group-hover:text-zinc-100'
            }`}
          >
            {task.title}
          </p>
          {task.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-zinc-600">{task.description}</p>
          )}
        </button>
      </td>
      <td className="px-4 py-3">
        <select
          value={task.status}
          onChange={(e) => void onStatusChange(task.id, e.target.value as TaskStatus)}
          disabled={isPending}
          aria-label={`Status for ${task.title}`}
          className="rounded-full border-0 bg-transparent p-0 text-[10px] focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:cursor-not-allowed"
        >
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <div className="mt-0.5">
          <StatusBadge status={task.status} />
        </div>
      </td>
      <td className="px-4 py-3">
        <PriorityBadge priority={task.priority} />
      </td>
      <td className="px-4 py-3">
        {task.assigned_agent ? (
          <span className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="text-base leading-none" aria-hidden="true">
              {task.assigned_agent.avatar_emoji ?? '🤖'}
            </span>
            <span className="max-w-[100px] truncate">{task.assigned_agent.name ?? 'Agent'}</span>
          </span>
        ) : (
          <span className="text-xs text-zinc-700">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {task.due_date ? (
          <span className="text-xs text-zinc-500" title={task.due_date}>
            {formatDate(task.due_date)}
          </span>
        ) : (
          <span className="text-xs text-zinc-700">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-zinc-600" title={task.updated_at}>
          {formatRelative(task.updated_at)}
        </span>
      </td>
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
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                  clipRule="evenodd"
                />
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
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </td>
    </tr>
  );
};
