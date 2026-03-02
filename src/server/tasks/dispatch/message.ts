import type { TaskPriority } from '@/lib/types';
import type { DispatchTaskRow } from './types';

const PRIORITY_EMOJI: Record<TaskPriority, string> = {
  low: '🔵',
  normal: '⚪',
  high: '🟡',
  urgent: '🔴',
};

export function buildDispatchTaskMessage(params: {
  task: DispatchTaskRow;
  missionControlUrl: string;
  taskProjectDir: string;
}): string {
  const { task, missionControlUrl, taskProjectDir } = params;
  const priorityEmoji = PRIORITY_EMOJI[task.priority] || '⚪';

  return `${priorityEmoji} **NEW TASK ASSIGNED**

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ''}
**Priority:** ${task.priority.toUpperCase()}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
**Task ID:** ${task.id}

**OUTPUT DIRECTORY:** ${taskProjectDir}
Create this directory and save all deliverables there.

**IMPORTANT:** After completing work, you MUST call these APIs:
1. Log activity: POST ${missionControlUrl}/api/tasks/${task.id}/activities
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${task.id}/deliverables
   Body: {"deliverable_type": "file", "title": "File name", "path": "${taskProjectDir}/filename.html"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${task.id}
   Body: {"status": "review"}

When complete, reply with:
\`TASK_COMPLETE: [brief summary of what you did]\`

If you need help or clarification, ask the orchestrator.`;
}

export function extractTaskCompleteSummary(text: string | undefined): string | null {
  const raw = String(text || '');
  const match = raw.match(/TASK_COMPLETE:\s*(.+)/i);
  if (!match) return null;
  const summary = match[1].trim();
  return summary.length > 0 ? summary : null;
}
