# Autonomous Worker - Vollstaendige Funktionsanalyse und technische Ausfuehrung

Stand: 2026-02-13

## 1. Ziel und Scope

Diese Analyse beschreibt die komplette aktuelle Implementierung der Funktion "Autonomous Worker" (vom UI-Einstieg bis zur Ausfuehrung im Backend), inklusive:

- Web-App Seite und UI-Interaktionen
- API-Routen und Status-Transitions
- Worker-Core (Queue, Planning, Execution, Approval, Testing, Completion)
- Datenhaltung in SQLite + Workspace-Dateisystem
- WebSocket Live-Status
- bekannte Ist-Luecken und Risiken

Referenz-Quellmodule:

- `src/modules/app-shell/components/AppShellViewContent.tsx`
- `WorkerView.tsx`
- `components/worker/*`
- `app/api/worker/*`
- `src/server/worker/*`
- `src/server/gateway/methods/worker.ts`
- `src/server/channels/messages/service.ts`

## 2. Gesamtarchitektur

### 2.1 Schichten

1. UI-Schicht
- `WorkerView.tsx` als Einstieg
- Kanban/Liste/Detail/Create-Views (`components/worker/*`)
- Frontend-Hooks fuer Tasks/Dateien (`src/modules/worker/hooks/*`)

2. API-Schicht (Next.js Route Handler)
- Task CRUD und Aktionen (`app/api/worker/route.ts`, `app/api/worker/[id]/route.ts`)
- Planning-Flow (`app/api/worker/[id]/planning/*`)
- Dateien/Export/Activities/Tests (`app/api/worker/[id]/*`)

3. Domain-Schicht (Worker Backend)
- Orchestrierung: `src/server/worker/workerAgent.ts`
- Planung: `src/server/worker/workerPlanner.ts`
- Step-Ausfuehrung: `src/server/worker/workerExecutor.ts`
- Persistenz: `src/server/worker/workerRepository.ts`
- Filesystem-Isolation: `src/server/worker/workspaceManager.ts`
- Benachrichtigungen: `src/server/worker/workerCallback.ts`
- Statusregeln: `src/server/worker/workerStateMachine.ts`

4. Transport-/Realtime-Schicht
- Gateway WS Client: `src/modules/gateway/ws-client.ts`
- Gateway Worker-Methoden: `src/server/gateway/methods/worker.ts`
- Broadcast: `src/server/gateway/broadcast.ts`

### 2.2 High-Level Flow

```text
UI/Chat -> API/Message Router -> WorkerRepository(createTask)
       -> processQueue() -> workerAgent(runWorkerAgent)
       -> planner(planTask) -> steps speichern
       -> executor(executeStep je Schritt)
       -> artifacts/logs/workspace
       -> optional webapp tests
       -> completed/review/failed + callbacks + worker.status events
```

## 3. Einstiege in den Worker

### 3.1 Einstieg ueber die Seite

- Die View `View.WORKER` rendert `WorkerView` in `AppShellViewContent`.
- `WorkerView` nutzt `useWorkerTasks()` fuer Laden/Anlegen/Aktionen.
- Task-Erstellung sendet `POST /api/worker` mit `objective`, optional `title`, `priority`, `workspaceType`, `usePlanning`.

### 3.2 Einstieg ueber Chat-Kommandos

- Router `routeMessage(...)` erkennt:
- `@worker ...` oder `/worker ...` => neue Task
- `/worker-status`, `/worker-list`, `/worker-cancel`, `/worker-retry`, `/worker-resume`, `/worker-assign`
- `/approve`, `/deny`, `/approve-always` fuer Approval
- Umsetzung in `src/server/channels/messages/service.ts`.

## 4. Task-Lebenszyklus und State Machine

### 4.1 Statusmodell

Definiert in `src/server/worker/workerTypes.ts`:

- `inbox`, `queued`, `assigned`
- `planning`, `clarifying`, `executing`, `waiting_approval`
- `testing`, `review`
- `completed`, `failed`, `cancelled`, `interrupted`

### 4.2 Transition-Regeln

`src/server/worker/workerStateMachine.ts` trennt:

- manuelle Transitions (Kanban/API move)
- systemische Transitions (Agentlauf)

Wichtig:

- aktive Status (`planning`, `executing`, `clarifying`, `waiting_approval`) sind manuell praktisch nur nach `cancelled` verschiebbar
- System darf universell nach `failed`, `cancelled`, `interrupted`

## 5. Persistenz und Datenhaltung

### 5.1 SQLite Tabellen

`src/server/worker/workerRepository.ts` legt an:

- `worker_tasks`
- `worker_steps`
- `worker_artifacts`
- `worker_task_activities`
- `worker_approval_rules`

### 5.2 Repository-Funktionen

Kernoperationen:

- Task: erstellen, status updaten, listen, active/queued ermitteln, checkpoint speichern
- Steps: speichern, status/output/toolcalls je Schritt
- Artefakte: speichern/lesen
- Activities: chronologischer Log
- Approval-Regeln: exact + einfache Prefix-Wildcards (`*`)

### 5.3 Workspace-Dateisystem

`workspaceManager` erstellt pro Task einen isolierten Ordner unter `workspaces/<taskId>/` inkl. Typ-Scaffold.

Workspace-Typen:

- `research`, `webapp`, `creative`, `data`, `general`

## 6. Ausfuehrung im Worker-Core

### 6.1 Queue-Verarbeitung

`processQueue()` in `workerAgent.ts`:

- globales Guard-Flag `isProcessing`
- holt FIFO naechste `queued` Task
- verarbeitet strikt sequentiell (eine Task gleichzeitig)

### 6.2 runWorkerAgent: Phasen

1. Workspace Setup
- bestehenden Workspace nutzen oder neu erzeugen
- DB `workspace_path` setzen

2. Planning
- Status auf `planning`
- `planTask(task)` via Model Hub
- Plan ist JSON-Array (max 10 Schritte), Fallback auf einen generischen Schritt
- Steps in DB speichern

3. Execution
- Status `executing`
- pro Schritt:
- `executeStep(task, step)` aufrufen
- Schrittstatus, output, toolCalls speichern
- checkpoint fortschreiben
- `logs/step-XXX.log` schreiben
- artifacts in DB + `output/` schreiben

4. Self-Verify
- wenn irgendein Schritt `failed` ist: Task `failed`
- sonst `plan.md` im Workspace schreiben

5. Optional Testing (nur `webapp`)
- Status `testing`
- `runWebappTests(wsPath)`
- `test-results.md` schreiben
- bei Test-Fehlern: Status `review`

6. Complete
- Summary aus Schritt-Outputs + Artefakten + Workspace-Statistik
- Status `completed`
- `notifyTaskCompleted(...)`

### 6.3 Step-Executor und Tool-Loop

`executeStep(...)` in `workerExecutor.ts`:

- erstellt Systemprompt (inkl. optionalem ClawHub Prompt-Block)
- ruft `dispatchWithFallback('p1', ...)` mit Tooldefinitionen
- verarbeitet Function-Calls provider-agnostisch
- loop bis finale Textantwort oder max 10 Tool-Loops

Verfuegbare Worker-Tools:

- `shell_execute`
- `file_read`
- `write_file`
- `browser_fetch`
- `python_execute`
- `search_web`

### 6.4 Approval-Flow bei Shell

Bei `shell_execute`:

- `requestCommandApproval(taskId, command)`
- Whitelist-Check ueber `worker_approval_rules`
- sonst Status `waiting_approval`, checkpoint mit `pendingCommand`
- Polling bis zu 5 Minuten auf `approvalResponse`
- danach weiter mit `executing` (approved oder denied)

Antwortwege fuer Approval:

- API PATCH action `approve|deny|approve-always`
- Chat-Kommandos `/approve`, `/deny`, `/approve-always`
- Gateway RPC `worker.approval.respond`

## 7. API-Oberflaeche (Ist-Zustand)

### 7.1 Task-Routen

- `GET /api/worker` -> Liste
- `POST /api/worker` -> Task erstellen
- `DELETE /api/worker` -> alle Tasks + Workspaces loeschen
- `GET /api/worker/[id]` -> Task + Steps + Artefakte
- `PATCH /api/worker/[id]` -> `cancel|resume|retry|approve|deny|approve-always|move|assign`
- `DELETE /api/worker/[id]` -> eine Task + Workspace loeschen

### 7.2 Zusatzrouten

- `GET /api/worker/[id]/activities`
- `GET|POST /api/worker/[id]/files`
- `GET /api/worker/[id]/export` (ZIP)
- `POST /api/worker/[id]/test`
- `GET|POST /api/worker/[id]/planning`
- `POST /api/worker/[id]/planning/answer`

## 8. UI-Seite und Bedienlogik

### 8.1 Hauptansicht

`WorkerView` bietet:

- Kanban (`WorkerKanbanBoard`) mit Drag-and-Drop und State-Machine-Validierung
- Listenansicht (`WorkerTaskList`)
- Create-Form (`WorkerTaskCreation`)
- Detailansicht (`WorkerTaskDetail`)
- Persona-Zuweisung (`WorkerPersonaSidebar`)

### 8.2 Detailansicht

`WorkerTaskDetail` bietet Tabs:

- Schritte
- Dateien (Workspace Browser + Preview)
- Output
- Aktivitaeten
- Live-Terminal (WS `worker.status`)
- Planung (Q&A und Spezifikation)

### 8.3 Realtime

- `useWorkerTasks` subscribed auf `worker.status` und patched Task-Status im State
- Terminal-Tab subscribed zusaetzlich und schreibt Logzeilen

## 9. Planungmodus (Clarifying Lane)

Wenn `usePlanning=true` bei Erstellung:

- Task startet in `inbox`
- `POST /planning` startet LLM-Q&A und setzt Status `clarifying`
- pro Antwort (`/planning/answer`) wird LLM erneut aufgerufen
- sobald Spezifikation kommt:
- objective wird mit Spezifikation angereichert
- `planning_complete=1`
- Status `queued`
- `processQueue()` startet normale Ausfuehrung

## 10. Testabdeckung (vorhanden)

Nachgewiesene Testmodule:

- Repository (CRUD, queue, checkpoint, approvals, activities)
- Planning-Persistenz
- State Machine Regeln
- Workspace Manager
- Worker Tester
- API Delete-Routen
- API Files Integrationslogik
- Executor Prompt-Hydration (ClawHub Prompt Block)

Dateien u. a.:

- `tests/workerRepository.test.ts`
- `tests/unit/worker/worker-planning.test.ts`
- `tests/unit/worker/worker-state-machine.test.ts`
- `tests/unit/worker/workspaceManager.test.ts`
- `tests/unit/worker/worker-tester.test.ts`
- `tests/integration/worker-delete-routes.test.ts`
- `tests/integration/worker-api-files.test.ts`

## 11. Beobachtete technische Luecken / Risiken

1. Task-Detaildatenfluss (Steps)
- `GET /api/worker/[id]` liefert `steps` top-level, aber `WorkerTaskDetail` liest `data.task.steps`.
- Ergebnis: Step-Anzeige kann leer/stale sein.

2. WS Subscription-Granularitaet
- `worker.task.subscribe` speichert `worker:<taskId>` Subscription.
- `broadcastStatus` nutzt aber global `broadcast(...)` statt `broadcastToSubscribed(...)`.
- Ergebnis: Task-spezifische Subscription wird aktuell nicht ausgenutzt.

3. Approval-Benachrichtigung nicht aktiv verdrahtet
- `notifyApprovalRequest(...)` existiert, wird aber im Approval-Pfad nicht aufgerufen.
- Es gibt damit keine explizite command-spezifische Push-Nachricht aus dem Executor-Pfad.

4. Doku-Drift
- `docs/WORKER_SYSTEM.md` listet alte Endpunkte (`/start`, `/stop`), die im aktuellen Route-Set nicht existieren.

5. Resume-Semantik
- `runWorkerAgent` plant bei Resume erneut und schreibt erneut Steps.
- Ohne explizites Reset/Versionierung kann dies zu inkonsistenter Step-Historie fuehren.

## 12. Technische Zusammenfassung

Die aktuelle "Autonomous Worker" Implementierung ist eine vollwertige serverseitige Agent-Orchestrierung mit:

- sequentieller Queue
- AI-basierter Planung
- Tool-basiertem Step-Executor
- Approval-Mechanismus fuer Shell-Befehle
- Workspace-Isolation und Artefaktpersistenz
- UI-Kanban + Detailanalyse + Planning-Q&A

Sie ist funktional breit ausgebaut, besitzt aber einige Integrationskanten (Detaildatenfluss, Event-Scoping, Approval-Notify-Verkabelung), die fuer eine robuste Produktivnutzung konsolidiert werden sollten.
