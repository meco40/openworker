# Phase 1: Kanban Board MVP — Implementierungsplan

**Datum:** 2026-02-13
**Elternplan:** [mission-control-integration.md](./2026-02-13-mission-control-integration.md)
**Ziel:** Worker-View von Flat List zu Drag-and-Drop Kanban Board umbauen.
**Neue Dependencies:** Keine.

---

## Übersicht der Tasks

| #   | Task                                                              | Dateien                 | Geschätzt |
| --- | ----------------------------------------------------------------- | ----------------------- | --------- |
| 1   | State Machine erstellen                                           | 1 neu, 1 test neu       | 20 min    |
| 2   | Status-Enum erweitern (Backend)                                   | 2 ändern                | 10 min    |
| 3   | Status-Enum erweitern (Frontend)                                  | 3 ändern                | 10 min    |
| 4   | Repository anpassen                                               | 1 ändern, 1 test ändern | 15 min    |
| 5   | Agent Cancellation-Check härten                                   | 1 ändern                | 5 min     |
| 6   | PATCH-Route erweitern (Status-Transitions + processQueue Trigger) | 1 ändern                | 15 min    |
| 7   | Gateway Worker-Methode erweitern                                  | 1 ändern                | 10 min    |
| 8   | Chat-Commands anpassen                                            | 1 ändern                | 10 min    |
| 9   | Kanban Board UI erstellen                                         | 1 neu, 1 CSS            | 30 min    |
| 10  | WorkerView umbauen                                                | 1 ändern                | 15 min    |
| 11  | WorkerTaskList STATUS_CONFIG erweitern                            | 1 ändern                | 5 min     |
| 12  | WorkerFlow + WorkerTaskDetail erweitern                           | 2 ändern                | 10 min    |
| 13  | End-to-End Verifikation                                           | —                       | 10 min    |

---

## Task 1: State Machine erstellen

**Files:**

- Create: `src/server/worker/workerStateMachine.ts`
- Create: `tests/unit/worker/worker-state-machine.test.ts`

### Step 1: Failing Test schreiben

**File: `tests/unit/worker/worker-state-machine.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import {
  canTransition,
  isActiveStatus,
  KANBAN_COLUMNS,
  type WorkerTaskStatus,
} from '@/src/server/worker/workerStateMachine';

describe('WorkerStateMachine', () => {
  describe('isActiveStatus', () => {
    it('returns true for agent-controlled statuses', () => {
      expect(isActiveStatus('planning')).toBe(true);
      expect(isActiveStatus('executing')).toBe(true);
      expect(isActiveStatus('clarifying')).toBe(true);
      expect(isActiveStatus('waiting_approval')).toBe(true);
    });

    it('returns false for non-active statuses', () => {
      expect(isActiveStatus('inbox')).toBe(false);
      expect(isActiveStatus('queued')).toBe(false);
      expect(isActiveStatus('assigned')).toBe(false);
      expect(isActiveStatus('testing')).toBe(false);
      expect(isActiveStatus('review')).toBe(false);
      expect(isActiveStatus('completed')).toBe(false);
      expect(isActiveStatus('failed')).toBe(false);
      expect(isActiveStatus('cancelled')).toBe(false);
      expect(isActiveStatus('interrupted')).toBe(false);
    });
  });

  describe('canTransition (manual)', () => {
    it('allows inbox → queued', () => {
      expect(canTransition('inbox', 'queued', 'manual')).toBe(true);
    });

    it('allows inbox → assigned', () => {
      expect(canTransition('inbox', 'assigned', 'manual')).toBe(true);
    });

    it('allows inbox → cancelled', () => {
      expect(canTransition('inbox', 'cancelled', 'manual')).toBe(true);
    });

    it('blocks inbox → executing', () => {
      expect(canTransition('inbox', 'executing', 'manual')).toBe(false);
    });

    it('allows assigned → queued', () => {
      expect(canTransition('assigned', 'queued', 'manual')).toBe(true);
    });

    it('allows assigned → inbox', () => {
      expect(canTransition('assigned', 'inbox', 'manual')).toBe(true);
    });

    it('blocks active status transitions except → cancelled', () => {
      expect(canTransition('executing', 'review', 'manual')).toBe(false);
      expect(canTransition('executing', 'cancelled', 'manual')).toBe(true);
      expect(canTransition('planning', 'queued', 'manual')).toBe(false);
      expect(canTransition('planning', 'cancelled', 'manual')).toBe(true);
      expect(canTransition('clarifying', 'cancelled', 'manual')).toBe(true);
      expect(canTransition('waiting_approval', 'cancelled', 'manual')).toBe(true);
    });

    it('allows testing → review', () => {
      expect(canTransition('testing', 'review', 'manual')).toBe(true);
    });

    it('allows testing → assigned (send back)', () => {
      expect(canTransition('testing', 'assigned', 'manual')).toBe(true);
    });

    it('allows review → completed', () => {
      expect(canTransition('review', 'completed', 'manual')).toBe(true);
    });

    it('allows review → assigned (send back)', () => {
      expect(canTransition('review', 'assigned', 'manual')).toBe(true);
    });

    it('allows completed → review (reopen)', () => {
      expect(canTransition('completed', 'review', 'manual')).toBe(true);
    });

    it('allows failed → queued (retry)', () => {
      expect(canTransition('failed', 'queued', 'manual')).toBe(true);
    });

    it('allows interrupted → queued (resume)', () => {
      expect(canTransition('interrupted', 'queued', 'manual')).toBe(true);
    });

    it('blocks invalid target', () => {
      expect(canTransition('completed', 'executing', 'manual')).toBe(false);
    });
  });

  describe('canTransition (system)', () => {
    it('allows queued → planning', () => {
      expect(canTransition('queued', 'planning', 'system')).toBe(true);
    });

    it('allows planning → executing', () => {
      expect(canTransition('planning', 'executing', 'system')).toBe(true);
    });

    it('allows executing → testing', () => {
      expect(canTransition('executing', 'testing', 'system')).toBe(true);
    });

    it('allows executing → review (skip testing)', () => {
      expect(canTransition('executing', 'review', 'system')).toBe(true);
    });

    it('allows any → failed (system)', () => {
      expect(canTransition('executing', 'failed', 'system')).toBe(true);
      expect(canTransition('planning', 'failed', 'system')).toBe(true);
      expect(canTransition('testing', 'failed', 'system')).toBe(true);
    });

    it('allows any → cancelled (system)', () => {
      expect(canTransition('executing', 'cancelled', 'system')).toBe(true);
    });

    it('allows any → interrupted (system)', () => {
      expect(canTransition('executing', 'interrupted', 'system')).toBe(true);
    });
  });

  describe('KANBAN_COLUMNS', () => {
    it('has 7 columns', () => {
      expect(KANBAN_COLUMNS).toHaveLength(7);
    });

    it('covers all statuses', () => {
      const allStatuses = KANBAN_COLUMNS.flatMap((col) => col.statuses);
      expect(allStatuses).toContain('inbox');
      expect(allStatuses).toContain('queued');
      expect(allStatuses).toContain('assigned');
      expect(allStatuses).toContain('planning');
      expect(allStatuses).toContain('executing');
      expect(allStatuses).toContain('testing');
      expect(allStatuses).toContain('review');
      expect(allStatuses).toContain('completed');
      expect(allStatuses).toContain('failed');
      expect(allStatuses).toContain('cancelled');
      expect(allStatuses).toContain('interrupted');
    });
  });
});
```

### Step 2: Test ausführen — FAIL erwartet

```bash
npm test -- tests/unit/worker/worker-state-machine.test.ts
```

Erwartet: FAIL — Modul existiert nicht.

### Step 3: Minimale Implementierung

**File: `src/server/worker/workerStateMachine.ts`**

```typescript
import type { WorkerTaskStatus } from './workerTypes';

export type { WorkerTaskStatus };

export type TransitionSource = 'manual' | 'system';

/**
 * Statuses where the agent is actively processing.
 * Manual transitions are blocked for these, except → cancelled.
 */
const ACTIVE_STATUSES: ReadonlySet<WorkerTaskStatus> = new Set([
  'planning',
  'executing',
  'clarifying',
  'waiting_approval',
]);

/** Check if a status is actively being processed by the agent. */
export function isActiveStatus(status: WorkerTaskStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Manual transitions table.
 * Key = current status, Value = set of allowed target statuses.
 * `cancelled` is always allowed as a target for any status.
 */
const MANUAL_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  inbox: new Set(['queued', 'assigned', 'cancelled']),
  assigned: new Set(['queued', 'inbox', 'cancelled']),
  queued: new Set(['inbox', 'cancelled']),
  // Active statuses: only cancelled allowed (enforced below)
  planning: new Set(['cancelled']),
  executing: new Set(['cancelled']),
  clarifying: new Set(['cancelled']),
  waiting_approval: new Set(['cancelled']),
  testing: new Set(['review', 'assigned', 'cancelled']),
  review: new Set(['completed', 'assigned', 'cancelled']),
  completed: new Set(['review']),
  failed: new Set(['queued', 'cancelled']),
  interrupted: new Set(['queued', 'cancelled']),
  cancelled: new Set([]),
};

/**
 * System transitions table.
 * The agent can move between these statuses programmatically.
 * `failed`, `cancelled`, `interrupted` are always allowed as targets.
 */
const SYSTEM_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  queued: new Set(['planning']),
  planning: new Set(['executing', 'clarifying']),
  clarifying: new Set(['planning', 'executing']),
  executing: new Set(['testing', 'review', 'waiting_approval', 'completed']),
  waiting_approval: new Set(['executing']),
  testing: new Set(['review', 'executing']),
  review: new Set(['completed']),
};

/** Universal system targets — always reachable from any status. */
const UNIVERSAL_SYSTEM_TARGETS: ReadonlySet<string> = new Set([
  'failed',
  'cancelled',
  'interrupted',
]);

/**
 * Check if a status transition is allowed.
 * @param from Current status
 * @param to Target status
 * @param source 'manual' (Kanban drag) or 'system' (agent/API)
 */
export function canTransition(
  from: WorkerTaskStatus,
  to: WorkerTaskStatus,
  source: TransitionSource,
): boolean {
  if (from === to) return false;

  if (source === 'manual') {
    const allowed = MANUAL_TRANSITIONS[from];
    return allowed ? allowed.has(to) : false;
  }

  // System transitions
  if (UNIVERSAL_SYSTEM_TARGETS.has(to)) return true;
  const allowed = SYSTEM_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

/** Kanban column definitions for UI rendering. */
export interface KanbanColumn {
  id: string;
  label: string;
  statuses: WorkerTaskStatus[];
}

export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
  { id: 'planning', label: 'Planung', statuses: ['planning', 'clarifying'] },
  { id: 'inbox', label: 'Eingang', statuses: ['inbox'] },
  { id: 'assigned', label: 'Zugewiesen', statuses: ['queued', 'assigned'] },
  { id: 'in-progress', label: 'In Arbeit', statuses: ['executing', 'waiting_approval'] },
  { id: 'testing', label: 'Testing', statuses: ['testing'] },
  { id: 'review', label: 'Review', statuses: ['review'] },
  { id: 'done', label: 'Erledigt', statuses: ['completed', 'failed', 'cancelled', 'interrupted'] },
] as const;
```

### Step 4: Test ausführen — PASS erwartet

```bash
npm test -- tests/unit/worker/worker-state-machine.test.ts
```

Erwartet: PASS — alle Tests grün.

### Step 5: Commit

```bash
git add src/server/worker/workerStateMachine.ts tests/unit/worker/worker-state-machine.test.ts
git commit -m "feat(worker): add state machine for Kanban transitions"
```

---

## Task 2: Status-Enum erweitern (Backend)

**Files:**

- Modify: `src/server/worker/workerTypes.ts`
- Modify: `src/server/worker/workerRepository.ts` (nur der Type-Import wird implizit geprüft)

### Step 1: workerTypes.ts — 3 neue Status-Werte hinzufügen

**In `src/server/worker/workerTypes.ts`**, den `WorkerTaskStatus` Type erweitern:

```typescript
// VORHER (L7-L10):
export type WorkerTaskStatus =
  | 'queued'
  | 'planning'
  | 'clarifying'
  | 'executing'
  | 'review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'waiting_approval';

// NACHHER:
export type WorkerTaskStatus =
  | 'inbox'
  | 'queued'
  | 'assigned'
  | 'planning'
  | 'clarifying'
  | 'executing'
  | 'testing'
  | 'review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'waiting_approval';
```

### Step 2: Typecheck

```bash
npm run typecheck
```

Erwartet: PASS — keine Compile-Fehler (neue Werte sind additiv).

### Step 3: Commit

```bash
git add src/server/worker/workerTypes.ts
git commit -m "feat(worker): add inbox, assigned, testing status values to backend type"
```

---

## Task 3: Status-Enum erweitern (Frontend)

**Files:**

- Modify: `types.ts` (root)

### Step 1: types.ts — Enum + Typen erweitern

**In `types.ts`**, den `WorkerTaskStatus` Enum (L168-L179) erweitern:

```typescript
// VORHER:
export enum WorkerTaskStatus {
  QUEUED = 'queued',
  PLANNING = 'planning',
  CLARIFYING = 'clarifying',
  EXECUTING = 'executing',
  WAITING_APPROVAL = 'waiting_approval',
  REVIEW = 'review',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  INTERRUPTED = 'interrupted',
}

// NACHHER:
export enum WorkerTaskStatus {
  INBOX = 'inbox',
  QUEUED = 'queued',
  ASSIGNED = 'assigned',
  PLANNING = 'planning',
  CLARIFYING = 'clarifying',
  EXECUTING = 'executing',
  WAITING_APPROVAL = 'waiting_approval',
  TESTING = 'testing',
  REVIEW = 'review',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  INTERRUPTED = 'interrupted',
}
```

### Step 2: Typecheck

```bash
npm run typecheck
```

Erwartet: PASS — neue Enum-Werte sind additiv, bestehender Code nutzt String-Literale.

### Step 3: Commit

```bash
git add types.ts
git commit -m "feat(worker): add INBOX, ASSIGNED, TESTING to frontend WorkerTaskStatus enum"
```

---

## Task 4: Repository anpassen

**Files:**

- Modify: `src/server/worker/workerRepository.ts`
- Modify: `tests/workerRepository.test.ts`

### Step 1: Failing Test schreiben

**Append to `tests/workerRepository.test.ts`**, inside the main `describe`:

```typescript
describe('state machine integration', () => {
  it('getActiveTask includes new active statuses', () => {
    repo.createTask(makeTask({ title: 'Active Test' }));
    const task = repo.getNextQueuedTask()!;
    repo.updateStatus(task.id, 'planning');
    const active = repo.getActiveTask();
    expect(active).not.toBeNull();
    expect(active!.id).toBe(task.id);
  });

  it('updateStatus sets started_at for planning status', () => {
    repo.createTask(makeTask({ title: 'Timing Test' }));
    const task = repo.getNextQueuedTask()!;
    repo.updateStatus(task.id, 'planning');
    const updated = repo.getTask(task.id)!;
    expect(updated.startedAt).toBeTruthy();
  });

  it('updateStatus sets completed_at for cancelled status', () => {
    repo.createTask(makeTask({ title: 'Cancel Test' }));
    const task = repo.getNextQueuedTask()!;
    repo.updateStatus(task.id, 'cancelled');
    const updated = repo.getTask(task.id)!;
    expect(updated.completedAt).toBeTruthy();
  });
});
```

### Step 2: Test ausführen — PASS prüfen (diese Tests sollten schon mit bestehendem Code funktionieren)

```bash
npm test -- tests/workerRepository.test.ts
```

Erwartet: PASS — bestehende Logik deckt das bereits ab.

### Step 3: Repository updateStatus für neue Statuses erweitern

**In `src/server/worker/workerRepository.ts`**, `updateStatus()` (ca. L149-L177):

```typescript
// VORHER — started_at Logik:
if (status === 'executing' || status === 'planning') {
  sets.push("started_at = datetime('now')");
}

// NACHHER — keine Änderung nötig, 'planning' ist bereits enthalten.

// VORHER — completed_at Logik:
if (status === 'completed' || status === 'failed' || status === 'cancelled') {
  sets.push("completed_at = datetime('now')");
}

// NACHHER — keine Änderung nötig, diese Statuses sind bereits abgedeckt.
```

**`getActiveTask()` erweitern** (ca. L214-L221):

```typescript
// VORHER:
WHERE status IN ('planning', 'executing', 'clarifying', 'waiting_approval')

// NACHHER — keine Änderung nötig für Phase 1.
// Die neuen Statuses (inbox, assigned, testing) sind NICHT "aktiv" im Agent-Sinne.
```

> **Fazit:** Keine Code-Änderungen am Repository in Phase 1 nötig. Die neuen Status-Werte sind rein additiv — der Type akzeptiert sie bereits über den String-basierten Status-Column.

### Step 4: Tests ausführen

```bash
npm test -- tests/workerRepository.test.ts
```

Erwartet: PASS.

### Step 5: Commit

```bash
git add tests/workerRepository.test.ts
git commit -m "test(worker): add state machine integration tests to repository"
```

---

## Task 5: Agent Cancellation-Check härten

**Files:**

- Modify: `src/server/worker/workerAgent.ts`

### Step 1: Problem identifizieren

In `workerAgent.ts` L99-L103 prüft der Cancellation-Check nur:

```typescript
if (!freshTask || freshTask.status === 'cancelled') {
```

Das reicht nicht — wenn ein User per Kanban den Task nach `inbox` verschiebt (was nur bei `queued` möglich wäre, nicht bei aktiven), oder der Task fehlerhaft in einen unerwarteten Status gerät, sollte der Agent das erkennen.

### Step 2: Cancellation-Check erweitern

**In `src/server/worker/workerAgent.ts`**, den Check bei L99-L103 ändern:

```typescript
// VORHER:
const freshTask = repo.getTask(task.id);
if (!freshTask || freshTask.status === 'cancelled') {
  repo.updateStatus(task.id, 'cancelled');
  return;
}

// NACHHER:
const freshTask = repo.getTask(task.id);
if (!freshTask || freshTask.status !== 'executing') {
  // Task was cancelled, moved, or externally modified — stop processing
  if (freshTask && freshTask.status !== 'cancelled' && freshTask.status !== 'failed') {
    repo.updateStatus(task.id, 'interrupted', {
      error: 'Task status changed externally during execution',
    });
  }
  return;
}
```

### Step 3: Typecheck + Tests

```bash
npm run typecheck
npm test -- tests/workerRepository.test.ts
```

Erwartet: PASS.

### Step 4: Commit

```bash
git add src/server/worker/workerAgent.ts
git commit -m "fix(worker): harden agent cancellation check to detect any status change"
```

---

## Task 6: PATCH-Route erweitern

**Files:**

- Modify: `app/api/worker/[id]/route.ts`

### Step 1: Neue `move` Action hinzufügen

In `app/api/worker/[id]/route.ts`, die PATCH-Handler-Logik erweitern. Neue Action `move` für Kanban-Drag:

```typescript
// Nach den bestehenden Actions (cancel, resume, retry, approve, deny, approve-always) hinzufügen:

case 'move': {
  const { status: targetStatus } = body;
  if (!targetStatus) {
    return NextResponse.json({ ok: false, error: 'Missing target status' }, { status: 400 });
  }

  const { canTransition } = await import('@/src/server/worker/workerStateMachine');
  if (!canTransition(task.status, targetStatus, 'manual')) {
    return NextResponse.json(
      { ok: false, error: `Transition ${task.status} → ${targetStatus} nicht erlaubt` },
      { status: 409 }
    );
  }

  repo.updateStatus(id, targetStatus);

  // Trigger processQueue wenn der Task in die Warteschlange kommt
  if (targetStatus === 'queued') {
    const { processQueue } = await import('@/src/server/worker/workerAgent');
    processQueue();
  }

  // Broadcast status change via WebSocket
  const { broadcast } = await import('@/src/server/gateway/broadcast');
  broadcast('worker.status', {
    taskId: id,
    status: targetStatus,
    message: `Status manuell geändert: ${task.status} → ${targetStatus}`,
    timestamp: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, task: repo.getTask(id) });
}
```

### Step 2: Typecheck

```bash
npm run typecheck
```

Erwartet: PASS.

### Step 3: Commit

```bash
git add app/api/worker/[id]/route.ts
git commit -m "feat(worker): add 'move' action to PATCH route with state machine validation"
```

---

## Task 7: Gateway Worker-Methode erweitern

**Files:**

- Modify: `src/server/gateway/methods/worker.ts`

### Step 1: Neue Methode `worker.task.updateStatus` registrieren

```typescript
// Neue Methode nach den bestehenden (worker.task.list, get, subscribe, unsubscribe, approval.respond):

registerMethod('worker.task.updateStatus', async (client, params) => {
  const { taskId, status } = params as { taskId: string; status: string };
  if (!taskId || !status) {
    return { ok: false, error: 'Missing taskId or status' };
  }

  const repo = getWorkerRepository();
  const task = repo.getTask(taskId);
  if (!task) {
    return { ok: false, error: 'Task not found' };
  }

  const { canTransition } = await import('@/src/server/worker/workerStateMachine');
  if (!canTransition(task.status, status as WorkerTaskStatus, 'manual')) {
    return { ok: false, error: `Transition ${task.status} → ${status} nicht erlaubt` };
  }

  repo.updateStatus(taskId, status as WorkerTaskStatus);

  if (status === 'queued') {
    const { processQueue } = await import('@/src/server/worker/workerAgent');
    processQueue();
  }

  broadcast('worker.status', {
    taskId,
    status,
    message: `Status geändert: ${task.status} → ${status}`,
    timestamp: new Date().toISOString(),
  });

  return { ok: true, task: repo.getTask(taskId) };
});
```

### Step 2: Typecheck

```bash
npm run typecheck
```

### Step 3: Commit

```bash
git add src/server/gateway/methods/worker.ts
git commit -m "feat(gateway): add worker.task.updateStatus method for Kanban transitions"
```

---

## Task 8: Chat-Commands anpassen

**Files:**

- Modify: `src/server/channels/messages/service.ts`

### Step 1: STATUS_ICONS Map erweitern

In der `/worker-list` Ausgabe-Logik, neue Status-Icons hinzufügen:

```typescript
// Bestehende Icon-Map um neue Statuses erweitern:
const statusIcons: Record<string, string> = {
  inbox: '📥',
  queued: '⏳',
  assigned: '👤',
  planning: '🧠',
  clarifying: '❓',
  executing: '⚙️',
  waiting_approval: '🔒',
  testing: '🧪',
  review: '👀',
  completed: '✅',
  failed: '❌',
  cancelled: '🚫',
  interrupted: '⚡',
};
```

### Step 2: Typecheck + Tests

```bash
npm run typecheck
npm test
```

### Step 3: Commit

```bash
git add src/server/channels/messages/service.ts
git commit -m "feat(worker): add new status icons to chat commands"
```

---

## Task 9: Kanban Board UI erstellen

**Files:**

- Create: `components/worker/WorkerKanbanBoard.tsx`
- Modify: `styles/worker.css`

### Step 1: Kanban Board Komponente

**File: `components/worker/WorkerKanbanBoard.tsx`**

```tsx
'use client';

import React, { useCallback, useState } from 'react';
import { WorkerTask, WorkerTaskStatus } from '@/types';
import {
  KANBAN_COLUMNS,
  canTransition,
  type KanbanColumn,
} from '@/src/server/worker/workerStateMachine';

interface WorkerKanbanBoardProps {
  tasks: WorkerTask[];
  onMoveTask: (taskId: string, targetStatus: WorkerTaskStatus) => Promise<void>;
  onSelectTask: (task: WorkerTask) => void;
  onCreateTask: () => void;
}

const STATUS_LABELS: Record<string, { label: string; icon: string }> = {
  inbox: { label: 'Eingang', icon: '📥' },
  queued: { label: 'Warteschlange', icon: '⏳' },
  assigned: { label: 'Zugewiesen', icon: '👤' },
  planning: { label: 'Planung', icon: '🧠' },
  clarifying: { label: 'Rückfragen', icon: '❓' },
  executing: { label: 'In Arbeit', icon: '⚙️' },
  waiting_approval: { label: 'Genehmigung', icon: '🔒' },
  testing: { label: 'Testing', icon: '🧪' },
  review: { label: 'Review', icon: '👀' },
  completed: { label: 'Abgeschlossen', icon: '✅' },
  failed: { label: 'Fehlgeschlagen', icon: '❌' },
  cancelled: { label: 'Abgebrochen', icon: '🚫' },
  interrupted: { label: 'Unterbrochen', icon: '⚡' },
};

export function WorkerKanbanBoard({
  tasks,
  onMoveTask,
  onSelectTask,
  onCreateTask,
}: WorkerKanbanBoardProps) {
  const [draggedTask, setDraggedTask] = useState<WorkerTask | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const getTasksForColumn = useCallback(
    (column: KanbanColumn): WorkerTask[] =>
      tasks.filter((t) => column.statuses.includes(t.status as WorkerTaskStatus)),
    [tasks],
  );

  const getDropStatus = useCallback(
    (column: KanbanColumn): WorkerTaskStatus | null => {
      if (!draggedTask) return null;
      // Find the first status in this column that the task can transition to
      for (const status of column.statuses) {
        if (canTransition(draggedTask.status as WorkerTaskStatus, status, 'manual')) {
          return status;
        }
      }
      return null;
    },
    [draggedTask],
  );

  const handleDragStart = useCallback((e: React.DragEvent, task: WorkerTask) => {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, column: KanbanColumn) => {
      const targetStatus = getDropStatus(column);
      if (targetStatus) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropTarget(column.id);
      }
    },
    [getDropStatus],
  );

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, column: KanbanColumn) => {
      e.preventDefault();
      setDropTarget(null);
      if (!draggedTask) return;

      const targetStatus = getDropStatus(column);
      if (targetStatus && targetStatus !== draggedTask.status) {
        await onMoveTask(draggedTask.id, targetStatus);
      }
      setDraggedTask(null);
    },
    [draggedTask, getDropStatus, onMoveTask],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedTask(null);
    setDropTarget(null);
  }, []);

  return (
    <div className="kanban-board">
      <div className="kanban-board__header">
        <h2>Worker Tasks</h2>
        <button className="worker-btn worker-btn--primary" onClick={onCreateTask}>
          + Neuer Task
        </button>
      </div>
      <div className="kanban-board__columns">
        {KANBAN_COLUMNS.map((column) => {
          const columnTasks = getTasksForColumn(column);
          const isValidTarget = dropTarget === column.id;

          return (
            <div
              key={column.id}
              className={`kanban-column ${isValidTarget ? 'kanban-column--drop-target' : ''}`}
              onDragOver={(e) => handleDragOver(e, column)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column)}
            >
              <div className="kanban-column__header">
                <span className="kanban-column__title">{column.label}</span>
                <span className="kanban-column__count">{columnTasks.length}</span>
              </div>
              <div className="kanban-column__body">
                {columnTasks.map((task) => {
                  const statusInfo = STATUS_LABELS[task.status] || {
                    label: task.status,
                    icon: '❔',
                  };
                  return (
                    <div
                      key={task.id}
                      className={`kanban-card ${draggedTask?.id === task.id ? 'kanban-card--dragging' : ''}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, task)}
                      onDragEnd={handleDragEnd}
                      onClick={() => onSelectTask(task)}
                    >
                      <div className="kanban-card__header">
                        <span className="kanban-card__status">{statusInfo.icon}</span>
                        <span className="kanban-card__priority">{task.priority}</span>
                      </div>
                      <div className="kanban-card__title">{task.title}</div>
                      {task.currentStep !== undefined &&
                        task.totalSteps !== undefined &&
                        task.totalSteps > 0 && (
                          <div className="kanban-card__progress">
                            <div
                              className="kanban-card__progress-bar"
                              style={{ width: `${(task.currentStep / task.totalSteps) * 100}%` }}
                            />
                            <span className="kanban-card__progress-text">
                              {task.currentStep}/{task.totalSteps}
                            </span>
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Step 2: CSS-Styles hinzufügen

**In `styles/worker.css`** die Kanban-Styles ergänzen (append):

```css
/* === Kanban Board === */
.kanban-board {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 1rem;
}

.kanban-board__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 0.5rem;
}

.kanban-board__columns {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  flex: 1;
  padding-bottom: 0.5rem;
}

.kanban-column {
  display: flex;
  flex-direction: column;
  min-width: 200px;
  flex: 1;
  background: var(--bg-secondary, #1e1e2e);
  border-radius: 8px;
  border: 2px solid transparent;
  transition: border-color 0.15s ease;
}

.kanban-column--drop-target {
  border-color: var(--accent, #3b82f6);
  background: var(--bg-hover, #2a2a3e);
}

.kanban-column__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary, #a0a0b0);
  border-bottom: 1px solid var(--border, #2a2a3e);
}

.kanban-column__count {
  background: var(--bg-tertiary, #2a2a3e);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
}

.kanban-column__body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem;
  flex: 1;
  overflow-y: auto;
}

.kanban-card {
  background: var(--bg-primary, #161622);
  border: 1px solid var(--border, #2a2a3e);
  border-radius: 6px;
  padding: 0.75rem;
  cursor: grab;
  transition:
    box-shadow 0.15s ease,
    opacity 0.15s ease;
}

.kanban-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.kanban-card--dragging {
  opacity: 0.4;
  cursor: grabbing;
}

.kanban-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
  font-size: 0.8rem;
}

.kanban-card__status {
  font-size: 0.9rem;
}

.kanban-card__priority {
  font-size: 0.7rem;
  text-transform: uppercase;
  color: var(--text-secondary, #a0a0b0);
}

.kanban-card__title {
  font-size: 0.85rem;
  font-weight: 500;
  line-height: 1.3;
  color: var(--text-primary, #e0e0f0);
  margin-bottom: 0.25rem;
}

.kanban-card__progress {
  position: relative;
  height: 4px;
  background: var(--bg-tertiary, #2a2a3e);
  border-radius: 2px;
  margin-top: 0.5rem;
  overflow: hidden;
}

.kanban-card__progress-bar {
  height: 100%;
  background: var(--accent, #3b82f6);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.kanban-card__progress-text {
  position: absolute;
  right: 0;
  top: -1.1rem;
  font-size: 0.65rem;
  color: var(--text-secondary, #a0a0b0);
}
```

### Step 3: Typecheck

```bash
npm run typecheck
```

### Step 4: Commit

```bash
git add components/worker/WorkerKanbanBoard.tsx styles/worker.css
git commit -m "feat(worker): add Kanban Board UI with HTML5 native DnD"
```

---

## Task 10: WorkerView umbauen

**Files:**

- Modify: `WorkerView.tsx`

### Step 1: WorkerView erweitern

View-States um `'kanban'` erweitern und als Default setzen:

```typescript
// VORHER:
const [view, setView] = useState<'list' | 'create' | 'detail'>('list');

// NACHHER:
const [view, setView] = useState<'kanban' | 'list' | 'create' | 'detail'>('kanban');
```

Neue `handleMoveTask` Funktion und `WorkerKanbanBoard` einbinden:

```typescript
import { WorkerKanbanBoard } from '@/components/worker/WorkerKanbanBoard';
import type { WorkerTaskStatus } from '@/src/server/worker/workerStateMachine';

// In der Komponente:
const handleMoveTask = useCallback(async (taskId: string, targetStatus: WorkerTaskStatus) => {
  const res = await fetch(`/api/worker/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'move', status: targetStatus }),
  });
  if (res.ok) {
    refreshTasks();
  }
}, [refreshTasks]);

// Im return JSX:
{view === 'kanban' && (
  <WorkerKanbanBoard
    tasks={tasks}
    onMoveTask={handleMoveTask}
    onSelectTask={handleSelectTask}
    onCreateTask={() => setView('create')}
  />
)}
```

Header-Bereich mit Toggle-Button für List/Kanban View:

```tsx
<div className="worker-view__toggle">
  <button
    className={`worker-btn ${view === 'kanban' ? 'worker-btn--primary' : 'worker-btn--ghost'}`}
    onClick={() => setView('kanban')}
  >
    ▦ Kanban
  </button>
  <button
    className={`worker-btn ${view === 'list' ? 'worker-btn--primary' : 'worker-btn--ghost'}`}
    onClick={() => setView('list')}
  >
    ☰ Liste
  </button>
</div>
```

### Step 2: Typecheck

```bash
npm run typecheck
```

### Step 3: Commit

```bash
git add WorkerView.tsx
git commit -m "feat(worker): integrate Kanban Board as default view in WorkerView"
```

---

## Task 11: WorkerTaskList STATUS_CONFIG erweitern

**Files:**

- Modify: `components/worker/WorkerTaskList.tsx`

### Step 1: STATUS_CONFIG Map um 3 neue Statuses erweitern

```typescript
// In STATUS_CONFIG Map (L17-L28), neue Einträge hinzufügen:
const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  inbox: { label: 'Eingang', color: '#8b5cf6', icon: '📥' },
  queued: { label: 'In Warteschlange', color: '#6b7280', icon: '⏳' },
  assigned: { label: 'Zugewiesen', color: '#0ea5e9', icon: '👤' },
  planning: { label: 'Planung', color: '#3b82f6', icon: '🧠' },
  clarifying: { label: 'Rückfragen', color: '#8b5cf6', icon: '❓' },
  executing: { label: 'In Arbeit', color: '#f59e0b', icon: '⚙️' },
  waiting_approval: { label: 'Genehmigung', color: '#ec4899', icon: '🔒' },
  testing: { label: 'Testing', color: '#14b8a6', icon: '🧪' },
  review: { label: 'Review', color: '#06b6d4', icon: '👀' },
  completed: { label: 'Abgeschlossen', color: '#10b981', icon: '✅' },
  failed: { label: 'Fehlgeschlagen', color: '#ef4444', icon: '❌' },
  cancelled: { label: 'Abgebrochen', color: '#6b7280', icon: '🚫' },
  interrupted: { label: 'Unterbrochen', color: '#f97316', icon: '⚡' },
};
```

### Step 2: Typecheck

```bash
npm run typecheck
```

### Step 3: Commit

```bash
git add components/worker/WorkerTaskList.tsx
git commit -m "feat(worker): add inbox, assigned, testing to TaskList STATUS_CONFIG"
```

---

## Task 12: WorkerFlow + WorkerTaskDetail erweitern

**Files:**

- Modify: `components/WorkerFlow.tsx`
- Modify: `components/worker/WorkerTaskDetail.tsx`

### Step 1: WorkerFlow — Testing-Node hinzufügen

In `WorkerFlow.tsx`, im `useMemo` nach dem Step-Loop und vor dem SYNC-Node:

```typescript
// Testing-Phase Node (nach Steps, vor SYNC):
if (status === 'testing') {
  nodes.push({
    id: 'testing',
    label: 'Testing',
    status: 'active',
  });
}
```

### Step 2: WorkerTaskDetail — `isActive` um neue Statuses erweitern

```typescript
// VORHER (L254):
const isActive = ['queued', 'planning', 'clarifying', 'executing', 'waiting_approval'].includes(
  task.status,
);

// NACHHER:
const isActive = [
  'queued',
  'planning',
  'clarifying',
  'executing',
  'waiting_approval',
  'testing',
].includes(task.status);
```

### Step 3: Typecheck

```bash
npm run typecheck
```

### Step 4: Commit

```bash
git add components/WorkerFlow.tsx components/worker/WorkerTaskDetail.tsx
git commit -m "feat(worker): extend WorkerFlow and TaskDetail for new statuses"
```

---

## Task 13: End-to-End Verifikation

### Step 1: Vollständige Test-Suite

```bash
npm run test
```

Erwartet: PASS — alle bestehenden + neuen Tests grün.

### Step 2: Typecheck

```bash
npm run typecheck
```

Erwartet: PASS — keine Compile-Fehler.

### Step 3: CI Gate

```bash
npm run check
```

Erwartet: PASS — typecheck + lint + format check.

### Step 4: Manuelle Verifikation (optional)

1. `npm run dev` — Server starten
2. Worker-View öffnen → Kanban Board ist Default
3. Task erstellen → erscheint in "Zugewiesen" Spalte (queued)
4. Task durch Spalten ziehen → Status ändert sich live
5. Aktiven Task (executing) versuchen auf "Eingang" zu ziehen → wird blockiert
6. Aktiven Task auf "Abgebrochen" ziehen → funktioniert → Agent stoppt
7. Toggle zu Listen-Ansicht → bestehende View unverändert
8. Chat: `/worker-list` → neue Icons korrekt

### Step 5: Finaler Commit

```bash
git add -A
git commit -m "feat(worker): Phase 1 complete — Kanban Board MVP with state machine"
```

---

## Anhang: Alle betroffenen Dateien (Checkliste)

- [ ] `src/server/worker/workerStateMachine.ts` — NEU (Task 1)
- [ ] `tests/unit/worker/worker-state-machine.test.ts` — NEU (Task 1)
- [ ] `src/server/worker/workerTypes.ts` — ÄNDERN (Task 2)
- [ ] `types.ts` — ÄNDERN (Task 3)
- [ ] `tests/workerRepository.test.ts` — ÄNDERN (Task 4)
- [ ] `src/server/worker/workerAgent.ts` — ÄNDERN (Task 5)
- [ ] `app/api/worker/[id]/route.ts` — ÄNDERN (Task 6)
- [ ] `src/server/gateway/methods/worker.ts` — ÄNDERN (Task 7)
- [ ] `src/server/channels/messages/service.ts` — ÄNDERN (Task 8)
- [ ] `components/worker/WorkerKanbanBoard.tsx` — NEU (Task 9)
- [ ] `styles/worker.css` — ÄNDERN (Task 9)
- [ ] `WorkerView.tsx` — ÄNDERN (Task 10)
- [ ] `components/worker/WorkerTaskList.tsx` — ÄNDERN (Task 11)
- [ ] `components/WorkerFlow.tsx` — ÄNDERN (Task 12)
- [ ] `components/worker/WorkerTaskDetail.tsx` — ÄNDERN (Task 12)
