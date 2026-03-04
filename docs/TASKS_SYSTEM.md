# Tasks System

## Metadata

- Purpose: Verbindliche Referenz fuer Task-Lifecycle, Planning, Dispatch, Testing und Deliverables.
- Scope: Task-Domain (`src/server/tasks/*`) und zugehoerige API-Routen unter `app/api/tasks/*`.
- Source of Truth: Diese Doku beschreibt den aktiven Stand und hat Vorrang vor archivierten Plan-/Review-Dokumenten.
- Last Reviewed: 2026-03-03
- Related Docs: `docs/API_REFERENCE.md`, `docs/MASTER_AGENT_SYSTEM.md`, `docs/PROJECT_WORKSPACE_SYSTEM.md`

---

## 1. Funktionsueberblick

Das Tasks-System verwaltet Arbeitsauftraege inklusive:

- Status-Lifecycle (`inbox` -> `assigned` -> `in_progress` -> `testing` -> `review` -> `done`)
- Planning-Sessions (Frage/Antwort-Flow + Dispatch-Vorbereitung)
- Deliverables und Activities pro Task
- Automatisierte Task-Tests
- Workspace-Erzeugung und Orphan-Cleanup

Hinweis: Es gibt aktuell **keinen** separaten Endpoint `/api/tasks/[id]/complete`.

---

## 2. Architektur

### 2.1 Wichtige Module

- `src/server/tasks/taskService.ts` - CRUD, Statuswechsel, Events, Auto-Dispatch Trigger
- `src/server/tasks/taskHydration.ts` - Relation-Hydration fuer Task-Antworten
- `src/server/tasks/taskWorkspace.ts` - Workspace-Erzeugung, Pfadhaertung, Cleanup
- `src/server/tasks/workspaceCleanupRuntime.ts` - Intervall-Cleanup fuer verwaiste Workspaces
- `src/server/tasks/autoTesting.ts` - Auto-Test Trigger + Deliverable-Autoregistrierung
- `src/server/tasks/dispatch/*` - Dispatch-Pipeline (prepare/execute/finalize/failure)
- `src/server/tasks/testing/*` - Test-Jobs und Ausfuehrungslogik
- `app/api/tasks/*` - HTTP-Routen

### 2.2 Persistenz

Task-Daten liegen in der zentralen Mission-Control-Datenbank (`DATABASE_PATH`, Default `mission-control.db`) in Tabellen wie:

- `tasks`
- `task_activities`
- `task_deliverables`
- `task_test_jobs` (wird durch Testing-Service initialisiert)

Task-Workspaces liegen dateibasiert unter `TASK_WORKSPACES_ROOT` (Default: `workspaces/`).

---

## 3. API-Routen

| Methode | Pfad                                      | Zweck                                        |
| ------- | ----------------------------------------- | -------------------------------------------- |
| GET     | `/api/tasks`                              | Taskliste mit Filtern laden                  |
| POST    | `/api/tasks`                              | Task erstellen                               |
| GET     | `/api/tasks/[id]`                         | Task-Details laden                           |
| PATCH   | `/api/tasks/[id]`                         | Task aktualisieren                           |
| DELETE  | `/api/tasks/[id]`                         | Task loeschen                                |
| GET     | `/api/tasks/[id]/activities`              | Activities lesen                             |
| POST    | `/api/tasks/[id]/activities`              | Activity eintragen                           |
| GET     | `/api/tasks/[id]/deliverables`            | Deliverables lesen                           |
| POST    | `/api/tasks/[id]/deliverables`            | Deliverable anlegen                          |
| POST    | `/api/tasks/[id]/dispatch`                | Dispatch fuer zugewiesenen Task starten      |
| GET     | `/api/tasks/[id]/planning`                | Planning-Status lesen                        |
| POST    | `/api/tasks/[id]/planning`                | Planning starten                             |
| DELETE  | `/api/tasks/[id]/planning`                | Planning abbrechen/reset                     |
| POST    | `/api/tasks/[id]/planning/answer`         | Antwort auf Planning-Frage uebermitteln      |
| GET     | `/api/tasks/[id]/planning/poll`           | Polling fuer Planning-Fortschritt            |
| POST    | `/api/tasks/[id]/planning/retry-dispatch` | Dispatch nach Planning-Fehler erneut starten |
| GET     | `/api/tasks/[id]/subagent`                | Subagent-Zuordnungen lesen                   |
| POST    | `/api/tasks/[id]/subagent`                | Subagent zuweisen                            |
| GET     | `/api/tasks/[id]/test`                    | Teststatus/Test-Info lesen                   |
| POST    | `/api/tasks/[id]/test`                    | Task-Tests ausloesen                         |

---

### 3.1 Task-Test-Jobmodell (`/api/tasks/[id]/test`)

- `POST /api/tasks/[id]/test` startet den Lauf asynchron und queued einen Job.
- `GET /api/tasks/[id]/test` liefert den zusammengefassten Teststatus.
- `GET /api/tasks/[id]/test?jobId=<id>` liefert den Detailstatus fuer einen konkreten Job.

Job-Statuswerte:

- `queued`
- `running`
- `completed`
- `failed`

Implementierung:

- Route-Adapter: `app/api/tasks/[id]/test/route.ts`
- Service: `src/server/tasks/testing/service.ts`
- Persistenz: Tabelle `task_test_jobs`

---

## 4. Statusmodell

Task-Status laut Schema (`tasks.status`):

- `pending_dispatch`
- `planning`
- `inbox`
- `assigned`
- `in_progress`
- `testing`
- `review`
- `done`

Spezialregel: Uebergang `review -> done` ist im Service auf Master-Agents beschraenkt.

---

## 5. Laufzeitkonfiguration

| Variable                                       | Default                             | Zweck                                           |
| ---------------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `DATABASE_PATH`                                | `mission-control.db`                | Zentrale SQLite fuer Task-Daten                 |
| `TASK_WORKSPACES_ROOT`                         | `workspaces`                        | Root fuer Task-Workspace-Ordner                 |
| `TASK_WORKSPACES_CLEANUP_ENABLED`              | `true`                              | Aktiviert/deaktiviert Workspace-Cleanup-Runtime |
| `TASK_WORKSPACES_CLEANUP_STARTUP`              | `true`                              | Fuehrt Cleanup beim Start aus                   |
| `TASK_WORKSPACES_CLEANUP_INTERVAL_MS`          | `1800000`                           | Intervall fuer periodisches Cleanup             |
| `TASK_WORKSPACES_CLEANUP_MAX_REMOVALS_PER_RUN` | `200`                               | Max. Loeschungen pro Cleanup-Lauf               |
| `TASK_AUTOTEST_HTTP_TRIGGER`                   | `true` (ausserhalb `NODE_ENV=test`) | Aktiviert HTTP-basierten Auto-Test-Trigger      |

---

## 6. Workspace-Cleanup CLI

Fuer manuelles/one-off Cleanup stehen folgende Skripte zur Verfuegung:

| Command                           | Zweck                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| `npm run workspaces:cleanup`      | Entfernt verwaiste Task-Workspaces und gibt menschenlesbares Ergebnis aus |
| `npm run workspaces:cleanup:json` | Gleiches Cleanup, aber als JSON-Report (geeignet fuer CI/Automationen)    |

Implementierung: `scripts/cleanup-task-workspaces.ts`

---

## 7. Verifikation

```bash
npm run typecheck
npm run lint
npm test -- tests/integration/mission-control/tasks-route-auto-testing.test.ts
npm test -- tests/integration/mission-control/tasks-route-workspaces.test.ts
npm test -- tests/integration/mission-control/tasks-route-agent-shape.test.ts
```

---

## 8. Siehe auch

- `docs/API_REFERENCE.md`
- `docs/MASTER_AGENT_SYSTEM.md`
- `docs/PROJECT_WORKSPACE_SYSTEM.md`
- `docs/OPS_OBSERVABILITY_SYSTEM.md`
