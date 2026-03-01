import type { TaskPriority, TaskStatus } from '@/lib/types';

export const ALL_STATUSES: TaskStatus[] = [
  'inbox',
  'pending_dispatch',
  'planning',
  'assigned',
  'in_progress',
  'testing',
  'review',
  'done',
];

export const ALL_PRIORITIES: TaskPriority[] = ['urgent', 'high', 'normal', 'low'];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  pending_dispatch: 'Pending',
  planning: 'Planning',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  testing: 'Testing',
  review: 'Review',
  done: 'Done',
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
  inbox: 'bg-zinc-700/60 text-zinc-300',
  pending_dispatch: 'bg-amber-900/50 text-amber-300',
  planning: 'bg-blue-900/50 text-blue-300',
  assigned: 'bg-indigo-900/50 text-indigo-300',
  in_progress: 'bg-violet-900/50 text-violet-300',
  testing: 'bg-cyan-900/50 text-cyan-300',
  review: 'bg-orange-900/50 text-orange-300',
  done: 'bg-emerald-900/50 text-emerald-300',
};

export const STATUS_DOT: Record<TaskStatus, string> = {
  inbox: 'bg-zinc-500',
  pending_dispatch: 'bg-amber-400',
  planning: 'bg-blue-400',
  assigned: 'bg-indigo-400',
  in_progress: 'bg-violet-400 animate-pulse',
  testing: 'bg-cyan-400',
  review: 'bg-orange-400',
  done: 'bg-emerald-500',
};

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  urgent: 'bg-red-900/60 text-red-300',
  high: 'bg-orange-900/50 text-orange-300',
  normal: 'bg-zinc-700/60 text-zinc-400',
  low: 'bg-zinc-800/60 text-zinc-600',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: '🔴 Urgent',
  high: '🟠 High',
  normal: '⚪ Normal',
  low: '🔵 Low',
};

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};
