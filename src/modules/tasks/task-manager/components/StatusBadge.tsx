import React from 'react';
import type { TaskStatus } from '@/lib/types';
import { STATUS_COLORS, STATUS_DOT, STATUS_LABELS } from '@/modules/tasks/task-manager/constants';

export const StatusBadge: React.FC<{ status: TaskStatus }> = ({ status }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_COLORS[status]}`}
  >
    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
    {STATUS_LABELS[status]}
  </span>
);
