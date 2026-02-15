import type { GatewayState, MemoryEntry, ScheduledTask } from '../types';

export interface PersonalityStat {
  subject: 'Communication' | 'Workflows' | 'Boundaries' | 'Time Awareness' | 'Proactivity';
  A: number;
  fullMark: 100;
}

export interface PersonalityMatrixResult {
  stats: PersonalityStat[];
  focus: string;
}

type PersonalityMatrixSource = Pick<GatewayState, 'memoryEntries' | 'scheduledTasks'>;

const DAY_IN_MS = 86_400_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeImportance(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 0.5;
  }

  return clamp(raw, 1, 10) / 10;
}

function recencyWeight(timestamp: string, nowMs: number): number {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return 0.35;
  }

  const ageDays = Math.max(0, (nowMs - parsed) / DAY_IN_MS);
  return Math.exp(-ageDays / 30);
}

function weightedSignal(entries: MemoryEntry[], nowMs: number): number {
  return entries.reduce((sum, entry) => {
    const importance = normalizeImportance(entry.importance);
    const recency = recencyWeight(entry.timestamp, nowMs);
    return sum + importance * recency;
  }, 0);
}

function saturatingScore(signal: number, target: number): number {
  if (signal <= 0) {
    return 0;
  }

  return clamp(Math.round(100 * (1 - Math.exp(-signal / target))), 0, 100);
}

function parseTaskTime(task: ScheduledTask): number {
  const parsed = Date.parse(task.targetTime);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function computeTimeAwareness(tasks: ScheduledTask[], nowMs: number): number {
  if (tasks.length === 0) {
    return 35;
  }

  const pending = tasks.filter((task) => task.status === 'pending');
  const pendingWithValidTime = pending.filter((task) => Number.isFinite(parseTaskTime(task)));

  const pendingFuture = pendingWithValidTime.filter((task) => parseTaskTime(task) >= nowMs).length;
  const pendingOverdue = pendingWithValidTime.filter((task) => parseTaskTime(task) < nowMs).length;

  const triggered = tasks.filter((task) => task.status === 'triggered');
  const triggeredRecent = triggered.filter((task) => {
    const targetTime = parseTaskTime(task);
    if (!Number.isFinite(targetTime)) {
      return false;
    }

    const ageDays = (nowMs - targetTime) / DAY_IN_MS;
    return ageDays >= 0 && ageDays <= 14;
  }).length;

  const futureRatio =
    pendingWithValidTime.length > 0 ? pendingFuture / pendingWithValidTime.length : 0;
  const overduePenalty =
    pendingWithValidTime.length > 0 ? pendingOverdue / pendingWithValidTime.length : 0;
  const triggeredRecentRatio = triggered.length > 0 ? triggeredRecent / triggered.length : 0;
  const planningCoverage = Math.min(1, pendingFuture / 5);

  const score =
    20 +
    futureRatio * 25 +
    (1 - overduePenalty) * 25 +
    triggeredRecentRatio * 20 +
    planningCoverage * 10;

  return clamp(Math.round(score), 0, 100);
}

function computeProactivity(
  tasks: ScheduledTask[],
  memoryEntries: MemoryEntry[],
  nowMs: number,
): number {
  if (tasks.length === 0 && memoryEntries.length === 0) {
    return 30;
  }

  const triggered = tasks.filter((task) => task.status === 'triggered');
  const cancelled = tasks.filter((task) => task.status === 'cancelled');

  const pendingFuture = tasks.filter((task) => {
    if (task.status !== 'pending') {
      return false;
    }

    const targetTime = parseTaskTime(task);
    return Number.isFinite(targetTime) && targetTime >= nowMs;
  }).length;

  const triggeredRecent14Days = triggered.filter((task) => {
    const targetTime = parseTaskTime(task);
    if (!Number.isFinite(targetTime)) {
      return false;
    }

    const ageDays = (nowMs - targetTime) / DAY_IN_MS;
    return ageDays >= 0 && ageDays <= 14;
  }).length;

  const completionRatio =
    triggered.length + cancelled.length > 0
      ? triggered.length / (triggered.length + cancelled.length)
      : 0.5;

  const executionCadence = Math.min(1, triggeredRecent14Days / 4);
  const learningScore = saturatingScore(weightedSignal(memoryEntries, nowMs), 5) / 100;
  const activePlanning = pendingFuture > 0 ? 1 : 0;

  const score =
    15 + completionRatio * 35 + executionCadence * 20 + learningScore * 20 + activePlanning * 10;

  return clamp(Math.round(score), 0, 100);
}

function focusFromWeakest(subject: PersonalityStat['subject']): string {
  switch (subject) {
    case 'Communication':
      return 'Strengthen communication memory quality with fresher preference signals.';
    case 'Workflows':
      return 'Capture and reuse workflow patterns more consistently to improve execution reliability.';
    case 'Boundaries':
      return 'Refine boundaries and avoidance rules to reduce recurring context friction.';
    case 'Time Awareness':
      return 'Improve time awareness by keeping pending tasks current and reducing overdue reminders.';
    case 'Proactivity':
    default:
      return 'Increase proactive follow-through with more recent triggered tasks and planning cadence.';
  }
}

export function buildPersonalityMatrix(
  source: PersonalityMatrixSource,
  now: Date = new Date(),
): PersonalityMatrixResult {
  const nowMs = now.getTime();
  const memoryEntries = source.memoryEntries ?? [];
  const tasks = source.scheduledTasks ?? [];

  if (memoryEntries.length === 0 && tasks.length === 0) {
    const stats: PersonalityStat[] = [
      { subject: 'Communication', A: 0, fullMark: 100 },
      { subject: 'Workflows', A: 0, fullMark: 100 },
      { subject: 'Boundaries', A: 0, fullMark: 100 },
      { subject: 'Time Awareness', A: 0, fullMark: 100 },
      { subject: 'Proactivity', A: 0, fullMark: 100 },
    ];
    return {
      stats,
      focus: 'No personality data yet. Save memory or schedule tasks to generate a matrix.',
    };
  }

  const communicationEntries = memoryEntries.filter(
    (entry) => entry.type === 'preference' || entry.type === 'personality_trait',
  );
  const workflowEntries = memoryEntries.filter(
    (entry) =>
      entry.type === 'fact' || entry.type === 'workflow_pattern' || entry.type === 'lesson',
  );
  const boundaryEntries = memoryEntries.filter((entry) => entry.type === 'avoidance');

  const stats: PersonalityStat[] = [
    {
      subject: 'Communication',
      A: saturatingScore(weightedSignal(communicationEntries, nowMs), 3.2),
      fullMark: 100,
    },
    {
      subject: 'Workflows',
      A: saturatingScore(weightedSignal(workflowEntries, nowMs), 3.8),
      fullMark: 100,
    },
    {
      subject: 'Boundaries',
      A: saturatingScore(weightedSignal(boundaryEntries, nowMs), 2.6),
      fullMark: 100,
    },
    {
      subject: 'Time Awareness',
      A: computeTimeAwareness(tasks, nowMs),
      fullMark: 100,
    },
    {
      subject: 'Proactivity',
      A: computeProactivity(tasks, memoryEntries, nowMs),
      fullMark: 100,
    },
  ];

  const weakest = stats.reduce((lowest, current) => (current.A < lowest.A ? current : lowest));

  return {
    stats,
    focus: focusFromWeakest(weakest.subject),
  };
}
