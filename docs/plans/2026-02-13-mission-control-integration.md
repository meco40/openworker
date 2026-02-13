# Mission-Control-Workflow Integration für OpenClaw Worker

**Datum:** 2026-02-13
**Status:** Geplant
**Referenz:** [crshdn/mission-control](https://github.com/crshdn/mission-control)

---

## Übersicht

Dreiphasige Integration des Mission-Control-Workflows in das bestehende Worker-System. Phase 1 liefert ein funktionales Kanban Board als MVP. Phase 2 fügt Persona-Integration und erweiterte Task-Details hinzu. Phase 3 bringt AI-gestützte Planning-Phase und optionale automatisierte Tests.

**Jede Phase ist eigenständig lauffähig.** Bestehende Features (Chat-Commands, Workspace-Dateisystem, Command-Approval, Resume/Checkpoint, Omnichannel) bleiben vollständig erhalten.

---

## Architektur-Entscheidungen

| Entscheidung | Gewählt | Verworfen | Grund |
|---|---|---|---|
| Agent-Entity | Bestehende Personas nutzen (`assigned_persona_id`) | Neues `worker_agents` Entity | Kein Parallel-System; Personas haben bereits SOUL.md, Emoji, Name |
| Drag-and-Drop | HTML5 native API | `@dnd-kit` | Keine neue Dependency; Mission Control nutzt dasselbe |
| Planning-LLM | Direkter Model-Hub Call (`dispatchWithFallback`) | Chat-Session + Polling | In-process, kein Polling-Overhead, kein Orchestrator-Agent nötig |
| State Machine | Explizite Transitions + Guard-Funktion | Freies Drag & Drop | Verhindert Race Conditions mit laufendem Agent |
| Testing | Node.js-basiert (HTML-Parse, css-tree) | Playwright Browser-Tests | ~200MB weniger Dependencies; Playwright optional später |
| Phasen-Aufteilung | 3 Phasen, je eigenständig lauffähig | Alles in einem Plan | YAGNI: Phase 1 liefert sofort Mehrwert |

---

## Kanban-Spalten → Status-Mapping

```
PLANNING        → planning, clarifying
INBOX           → inbox (NEU)
ASSIGNED        → assigned (NEU)
IN PROGRESS     → executing, waiting_approval
TESTING         → testing (NEU)
REVIEW          → review
DONE            → completed, failed, cancelled, interrupted
```

---

## State Machine — Erlaubte Übergänge

### System-Transitions (Agent-Loop)

```
queued → planning → executing → testing → review → completed
                  ↘ clarifying ↗
                  ↘ waiting_approval ↗
         * → failed
         * → cancelled
         * → interrupted
```

### Manuelle Transitions (Kanban Drag)

Nur erlaubt wenn Task **nicht aktiv** vom Agent bearbeitet wird.
Aktive Statuses (blockiert): `planning`, `executing`, `clarifying`, `waiting_approval`.
Ausnahme: `→ cancelled` ist immer erlaubt.

| Von | Erlaubte manuelle Ziele |
|---|---|
| `inbox` | `queued`, `assigned`, `cancelled` |
| `assigned` | `queued`, `inbox`, `cancelled` |
| `queued` | `inbox`, `cancelled` |
| `testing` | `review`, `assigned`, `cancelled` |
| `review` | `completed`, `assigned`, `cancelled` |
| `completed` | `review` (Reopen) |
| `failed` | `queued` (Retry), `cancelled` |
| `interrupted` | `queued` (Resume), `cancelled` |
| `planning`/`executing`/`clarifying`/`waiting_approval` | nur `cancelled` |

---

## Risiko-Mitigationen

| Risiko | Mitigation |
|---|---|
| Race Condition: Agent überschreibt Kanban-Status | State Machine blockiert manuelle Transitions für aktive Tasks. Agent-Loop prüft `!== 'executing'` statt nur `=== 'cancelled'` |
| `processQueue()` wird nicht getriggert bei Kanban-Drag | Expliziter `processQueue()` Aufruf in PATCH-Route bei Status-Änderung zu `queued` |
| 10+ Stellen für neue Statuses | Vollständige Änderungsliste in Phase-1-Plan dokumentiert |
| Persona-System Duplikation | Kein neues Entity — direkte FK `assigned_persona_id → personas.id` |
| Planning-Phase Architektur-Mismatch | Direkter LLM-Call statt MC's Polling-Muster |
| Playwright Dependency-Footprint | Node.js-basierte Tests als Default, Playwright optional |
| Tests brechen durch Schema-Änderung | Alle neuen Spalten nullable, bestehende Tests unverändert lauffähig |

---

## Phase 1: Kanban Board MVP

**Ziel:** Flat Grid → Drag-and-Drop Kanban mit 7 Spalten.
**Neue Dependencies:** Keine.

### Steps

1. **State Machine** — `src/server/worker/workerStateMachine.ts`
2. **Status-Enum erweitern** — `inbox`, `assigned`, `testing` in 12 Dateien
3. **`processQueue()` Trigger** — bei Kanban-Drag auf `queued`
4. **Kanban Board UI** — `components/worker/WorkerKanbanBoard.tsx` mit HTML5 DnD
5. **WorkerView umbauen** — Kanban als Default, Modals statt View-States
6. **WebSocket-Events erweitern** — `worker.task.updateStatus` Methode, reichere Payloads

### Dateien die geändert werden (vollständig)

| Datei | Art |
|---|---|
| `src/server/worker/workerStateMachine.ts` | NEU |
| `src/server/worker/workerTypes.ts` | ÄNDERN — 3 neue Status-Werte |
| `types.ts` | ÄNDERN — 3 neue Enum-Werte |
| `src/server/worker/workerRepository.ts` | ÄNDERN — `updateStatus()` Timestamps, `getActiveTask()` SQL |
| `src/server/worker/workerAgent.ts` | ÄNDERN — Cancellation-Check erweitern |
| `components/worker/WorkerTaskList.tsx` | ÄNDERN — `STATUS_CONFIG` Map |
| `components/WorkerFlow.tsx` | ÄNDERN — Flow-Nodes für neue Statuses |
| `components/worker/WorkerTaskDetail.tsx` | ÄNDERN — Action-Buttons |
| `src/server/channels/messages/service.ts` | ÄNDERN — Status-Guards |
| `src/server/gateway/methods/worker.ts` | ÄNDERN — Neue Methode, reichere Events |
| `components/worker/WorkerKanbanBoard.tsx` | NEU |
| `WorkerView.tsx` | ÄNDERN — Layout-Umbau |
| `tests/workerRepository.test.ts` | ÄNDERN — State-Machine-Tests |
| `tests/unit/worker/worker-state-machine.test.ts` | NEU |
| `app/api/worker/[id]/route.ts` | ÄNDERN — processQueue Trigger |

### Verifikation

- `npm run typecheck` — neue Status-Werte kompilieren
- `npm run test` — bestehende + neue Tests grün
- Manuell: Task erstellen → durch Kanban ziehen → Live-Update via WS → blockierter Drag bei aktivem Task
- `npm run check` — CI Gate (typecheck + lint + format)

---

## Phase 2: Persona-Integration & Task-Details

**Ziel:** Personas als Agents zuweisen, erweiterte Task-Detail-Ansicht, Activity Log.

### Steps

7. **`assigned_persona_id` auf worker_tasks** — Schema-Migration, Types, Row-Mapper, API-JOINs
8. **Persona-Sidebar** — `components/worker/WorkerPersonaSidebar.tsx`, bestehende Persona-API nutzen
9. **Task-Detail-Modal erweitern** — Tab-System: Übersicht, Schritte, Dateien, Aktivitäten, Terminal
10. **Activity Log Backend** — `worker_task_activities` Tabelle, automatisches Logging in `workerAgent.ts`
11. **Chat-Command-Erweiterungen** — `/worker-assign`, erweiterte `/worker-list` und `/worker-status` Ausgabe

### Dateien

| Datei | Art |
|---|---|
| `src/server/worker/workerRepository.ts` | ÄNDERN — Migration, CRUD für Activities |
| `src/server/worker/workerTypes.ts` | ÄNDERN — `assignedPersonaId`, `TaskActivity` Type |
| `src/server/worker/workerRowMappers.ts` | ÄNDERN — neues Feld |
| `types.ts` | ÄNDERN — Frontend-Types |
| `app/api/worker/route.ts` | ÄNDERN — JOIN auf personas |
| `app/api/worker/[id]/route.ts` | ÄNDERN — Persona-Zuweisung |
| `app/api/worker/[id]/activities/route.ts` | NEU |
| `components/worker/WorkerPersonaSidebar.tsx` | NEU |
| `components/worker/WorkerTaskDetail.tsx` | ÄNDERN — Tab-System |
| `components/worker/WorkerActivityTab.tsx` | NEU |
| `WorkerView.tsx` | ÄNDERN — Sidebar-Layout |
| `src/server/worker/workerAgent.ts` | ÄNDERN — Activity-Logging |
| `src/server/channels/messages/service.ts` | ÄNDERN — neue Commands |
| `src/server/gateway/methods/worker.ts` | ÄNDERN — `worker.activity` Event |

### Verifikation

- Persona zuweisen → Kanban zeigt Emoji → Sidebar zeigt "arbeitend"
- Chat: `/worker-assign` → Task bekommt Persona
- Activity-Tab zeigt chronologischen Verlauf
- `npm run check`

---

## Phase 3: AI Planning & Automated Testing

**Ziel:** Interaktiver Planungsprozess und optionale Qualitätsprüfung.

### Steps

12. **Planning-Phase Backend** — Direkter Model-Hub LLM-Call, Q&A als strukturiertes JSON
13. **Planning UI** — `components/worker/WorkerPlanningTab.tsx`, Multiple-Choice Cards
14. **Automated Testing** — Node.js-basiert (HTML-Parse, css-tree), nur für `webapp` Tasks

### Dateien

| Datei | Art |
|---|---|
| `app/api/worker/[id]/planning/route.ts` | NEU — Start + State-Abfrage |
| `app/api/worker/[id]/planning/answer/route.ts` | NEU — Antwort-Verarbeitung |
| `app/api/worker/[id]/test/route.ts` | NEU — Automated Testing |
| `src/server/worker/workerRepository.ts` | ÄNDERN — Migration (planning_messages, planning_complete) |
| `src/server/worker/workerTypes.ts` | ÄNDERN — Planning-Types |
| `components/worker/WorkerPlanningTab.tsx` | NEU |
| `components/worker/WorkerTaskCreation.tsx` | ÄNDERN — Planning-Modus Toggle |
| `src/server/worker/workerAgent.ts` | ÄNDERN — Testing-Phase nach Self-Verify |

### Verifikation

- Task mit Planning-Modus erstellen → Q&A Flow → Spec generiert → Status `inbox`
- Webapp-Task → nach Completion → automatische Tests → `review` oder zurück
- `npm run check`
