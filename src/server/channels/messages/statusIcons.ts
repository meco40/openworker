const STATUS_ICONS: Record<string, string> = {
  queued: '⏳',
  planning: '📝',
  executing: '⚙️',
  completed: '✅',
  failed: '❌',
  cancelled: '🛑',
  interrupted: '⚡',
  waiting_approval: '⚠️',
  clarifying: '❓',
  review: '🔍',
};

export function statusIconForWorker(status: string): string {
  return STATUS_ICONS[status] || '❔';
}
