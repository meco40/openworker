const STATUS_ICONS: Record<string, string> = {
  inbox: '📥',
  queued: '⏳',
  assigned: '👤',
  planning: '📝',
  clarifying: '❓',
  executing: '⚙️',
  waiting_approval: '⚠️',
  testing: '🧪',
  review: '🔍',
  completed: '✅',
  failed: '❌',
  cancelled: '🛑',
  interrupted: '⚡',
};

export function statusIconForWorker(status: string): string {
  return STATUS_ICONS[status] || '❔';
}
