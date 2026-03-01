import React from 'react';
import type { TaskPriority } from '@/lib/types';
import { PRIORITY_COLORS, PRIORITY_LABELS } from '@/modules/tasks/task-manager/constants';

export const PriorityBadge: React.FC<{ priority: TaskPriority }> = ({ priority }) => (
  <span
    className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_COLORS[priority]}`}
  >
    {PRIORITY_LABELS[priority]}
  </span>
);
