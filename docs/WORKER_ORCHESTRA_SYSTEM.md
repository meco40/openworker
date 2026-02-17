# Worker Orchestra System

**Stand:** 2026-02-17

## 1. Funktionserläuterung

Worker Orchestra verwaltet graphbasierte Workflows (Draft/Published) und die statusbasierte Ausführung pro Node/Run.

### Kernkonzepte

- **Flow Draft**: Bearbeitbarer Workflow-Entwurf
- **Published Flow**: Versionierter, ausführbarer Workflow
- **Run**: Konkrete Ausführung eines veröffentlichten Flows
- **Node Status**: Laufzeitstatus je Node im Run
- **Workflow View**: Read-only Sicht auf aktiven Task-Workflow

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/worker/orchestraService.ts`
- `src/server/worker/orchestraRunner.ts`
- `src/server/worker/orchestraGraph.ts`
- `src/server/worker/orchestraValidator.ts`
- `src/server/worker/orchestraWorkflow.ts`
- `src/server/worker/orchestraFlags.ts`
- `src/server/worker/repositories/flowRepository.ts`
- `app/api/worker/orchestra/flows/*`
- `app/api/worker/[id]/workflow/route.ts`

### 2.2 Flags

Workflow-Routen sind flag-abhängig (`isWorkerOrchestraEnabled`, `isWorkerWorkflowTabEnabled`).
Bei deaktivierten Flags liefern relevante Routen `404`.

---

## 3. API-Referenz

### 3.1 Flow Lifecycle

| Methode | Pfad                                       | Zweck                     |
| ------- | ------------------------------------------ | ------------------------- |
| GET     | `/api/worker/orchestra/flows`              | Drafts + Published listen |
| POST    | `/api/worker/orchestra/flows`              | Draft erstellen           |
| GET     | `/api/worker/orchestra/flows/[id]`         | Draft/Published laden     |
| PATCH   | `/api/worker/orchestra/flows/[id]`         | Draft/Published ändern    |
| DELETE  | `/api/worker/orchestra/flows/[id]`         | Draft/Published löschen   |
| POST    | `/api/worker/orchestra/flows/[id]/publish` | Draft veröffentlichen     |

### 3.2 Task Workflow Ansicht

| Methode | Pfad                        | Zweck                                |
| ------- | --------------------------- | ------------------------------------ |
| GET     | `/api/worker/[id]/workflow` | Node-/Edge-/Status-Snapshot für Task |

### 3.3 Zugehörige Task-Routen

| Methode | Pfad                            | Zweck                   |
| ------- | ------------------------------- | ----------------------- |
| GET     | `/api/worker/[id]/subagents`    | Subagent-Sessions laden |
| POST    | `/api/worker/[id]/subagents`    | Subagent erstellen      |
| PATCH   | `/api/worker/[id]/subagents`    | Subagent-Status setzen  |
| GET     | `/api/worker/[id]/deliverables` | Deliverables laden      |
| POST    | `/api/worker/[id]/deliverables` | Deliverable erstellen   |

---

## 4. Statusmodelle

### 4.1 Flow

- `draft`
- `published`
- `archived`

### 4.2 Run

- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`

### 4.3 Node

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`

---

## 5. Verifikation

```bash
npm run test -- tests/unit/worker/orchestra-*
npm run test -- tests/integration/worker/orchestra-*
npm run typecheck
npm run lint
```

---

## 6. Siehe auch

- `docs/WORKER_SYSTEM.md`
- `docs/PERSONA_ROOMS_SYSTEM.md`
- `docs/API_REFERENCE.md`
