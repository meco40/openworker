# Worker System

**Stand:** 2026-02-17

## 1. Funktionserläuterung

Das Worker-System führt mehrstufige Aufgaben asynchron aus (Planung, Ausführung, Review, Artefakte) und unterstützt Subagents, Deliverables sowie Orchestra-Workflows.

### Kernkonzepte

- **Task**: Persistierte Arbeitseinheit mit Statusmaschine
- **Planung**: Optionale Rückfragen + Planerstellung
- **Execution**: Schrittweise Ausführung mit Tool-/Agent-Loop
- **Approval**: `waiting_approval` mit expliziten Entscheidungen
- **Workspace**: Dateibasierter Arbeitsbereich pro Task

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/worker/workerRepository.ts`
- `src/server/worker/workerStateMachine.ts`
- `src/server/worker/workerPlanner.ts`
- `src/server/worker/workerExecutor.ts`
- `src/server/worker/workerAgent.ts`
- `src/server/worker/workspaceManager.ts`
- `src/server/worker/openai/*`
- `app/api/worker/*`

### 2.2 Task-Aktionen über PATCH

`PATCH /api/worker/[id]` verarbeitet u. a.:

- `cancel`
- `resume`
- `retry`
- `approve`
- `deny`
- `approve-always`
- `move` (Statuswechsel)
- `assign` (Persona-Zuweisung)

---

## 3. API-Referenz

### 3.1 Core

| Methode | Pfad                          | Zweck                            |
| ------- | ----------------------------- | -------------------------------- |
| GET     | `/api/worker`                 | Tasks auflisten                  |
| POST    | `/api/worker`                 | Task erstellen                   |
| DELETE  | `/api/worker`                 | Bulk-Delete                      |
| GET     | `/api/worker/[id]`            | Task inkl. Steps/Artifacts laden |
| PATCH   | `/api/worker/[id]`            | Task-Aktion ausführen            |
| DELETE  | `/api/worker/[id]`            | Task + Workspace löschen         |
| POST    | `/api/worker/[id]/test`       | Task-Workspace testen            |
| GET     | `/api/worker/[id]/activities` | Aktivitätsfeed                   |

### 3.2 Planung, Files, Export

| Methode | Pfad                               | Zweck                      |
| ------- | ---------------------------------- | -------------------------- |
| GET     | `/api/worker/[id]/planning`        | Planung-Status laden       |
| POST    | `/api/worker/[id]/planning`        | Planung starten/fortsetzen |
| POST    | `/api/worker/[id]/planning/answer` | Antwort auf Planung-Frage  |
| GET     | `/api/worker/[id]/files`           | Workspace lesen            |
| POST    | `/api/worker/[id]/files`           | Datei schreiben            |
| GET     | `/api/worker/[id]/export`          | Workspace exportieren      |

### 3.3 Subagents, Deliverables, Workflow

| Methode | Pfad                            | Zweck                         |
| ------- | ------------------------------- | ----------------------------- |
| GET     | `/api/worker/[id]/subagents`    | Subagent-Sessions auflisten   |
| POST    | `/api/worker/[id]/subagents`    | Subagent-Session erstellen    |
| PATCH   | `/api/worker/[id]/subagents`    | Subagent-Status aktualisieren |
| GET     | `/api/worker/[id]/deliverables` | Deliverables laden            |
| POST    | `/api/worker/[id]/deliverables` | Deliverable erstellen         |
| GET     | `/api/worker/[id]/workflow`     | Orchestra-Workflow-Ansicht    |

### 3.4 Settings und Orchestra

| Methode | Pfad                                       | Zweck                     |
| ------- | ------------------------------------------ | ------------------------- |
| GET     | `/api/worker/settings`                     | Worker-Settings laden     |
| PUT     | `/api/worker/settings`                     | Worker-Settings speichern |
| GET     | `/api/worker/orchestra/flows`              | Flows auflisten           |
| POST    | `/api/worker/orchestra/flows`              | Flow erstellen            |
| GET     | `/api/worker/orchestra/flows/[id]`         | Flow abrufen              |
| PATCH   | `/api/worker/orchestra/flows/[id]`         | Flow aktualisieren        |
| DELETE  | `/api/worker/orchestra/flows/[id]`         | Flow löschen              |
| POST    | `/api/worker/orchestra/flows/[id]/publish` | Flow veröffentlichen      |

---

## 4. Verifikation

```bash
npm run test -- tests/unit/worker
npm run test -- tests/integration/worker
npm run typecheck
npm run lint
```

---

## 5. Siehe auch

- `docs/WORKER_ORCHESTRA_SYSTEM.md`
- `docs/SKILLS_SYSTEM.md`
- `docs/API_REFERENCE.md`
