# 🔍 Tiefe Analyse: Worker Workflow

**Datum:** 2026-02-15  
**Analyst:** Kimi Code CLI  
**Scope:** Vollständige Analyse des Worker-Task-Systems

---

## 1. Task Creation Flow (Wie legt der User eine Task an?)

### UI-Eingabe (`WorkerTaskCreation.tsx`)

```
┌─────────────────────────────────────────────┐
│  User wählt:                                │
│  • Workspace-Type (research/webapp/...)     │
│  • Titel (optional)                         │
│  • Aufgabe (Pflicht)                        │
│  • Priorität (low/normal/high/urgent)       │
│  • Planungsmodus (Ja/Nein)                  │
└────────────────┬────────────────────────────┘
                 │
                 ▼
```

### API Route (`POST /api/worker`)

```typescript
// 1. Validierung: objective required
// 2. Conversation-Zuordnung (WebChat default)
// 3. Task in DB erstellen (Status: 'queued' oder 'inbox')
// 4. Queue-Prozessor starten (nur ohne Planning-Modus)
```

### Datenbank-Schema (`workerRepository.ts`)

```sql
worker_tasks:
- id, title, objective, status
- priority, workspace_type, user_id
- assigned_persona_id          -- Persona-Zuweisung
- flow_published_id            -- Orchestra Flow
- current_step, total_steps
- last_checkpoint              -- Für Resume
- created_at, started_at, completed_at

worker_steps:
- id, task_id, step_index, description
- status, output, tool_calls

worker_task_activities:        -- Audit-Log
- id, task_id, type, message, metadata
```

---

## 2. Workflow-Phasen (Was passiert danach?)

### Überblick

```
┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌─────────────────┐
│  QUEUED  │──▶│ PLANNING │──▶│  EXECUTING   │──▶│   TESTING       │
│          │   │          │   │              │   │   (webapp only) │
└──────────┘   └──────────┘   └──────────────┘   └────────┬────────┘
     │                                                    │
     │         ┌──────────────────────────────────────────┘
     │         ▼
     │    ┌─────────┐   ┌──────────┐   ┌──────────┐
     └───▶│  FAILED │   │  REVIEW  │──▶│ COMPLETED│
            │         │   │          │   │          │
            └─────────┘   └──────────┘   └──────────┘
```

### Detaillierte Phasen (`standardTaskPhase.ts`)

| Phase               | Funktion                     | Beschreibung                                |
| ------------------- | ---------------------------- | ------------------------------------------- |
| **1. Planning**     | `planTask()`                 | AI generiert Schritt-Plan (max 10 Schritte) |
| **2. Execution**    | `executeExecutionPhase()`    | Jeder Schritt wird einzeln ausgeführt       |
| **3. Verification** | `executeVerificationPhase()` | Prüfung auf failed Steps                    |
| **4. Testing**      | `executeTestingPhase()`      | Webapp: `npm test` ausführen                |
| **5. Completion**   | `executeCompletionPhase()`   | Zusammenfassung + Benachrichtigung          |

### Phase: Execution Details

```typescript
for (let i = startStepIndex; i < steps.length; i++) {
  // 1. Cancellation-Check
  // 2. Step ausführen (executeStep)
  // 3. Tool-Calls loggen
  // 4. Artifacts speichern
  // 5. Checkpoint speichern
  // 6. Step-Log in workspace/logs/ schreiben
}
```

---

## 3. State Machine (`workerStateMachine.ts`)

### Status-Übergänge

```
MANUAL (User via Kanban):
┌─────────┐    ┌─────────┐    ┌─────────┐
│ inbox   │───▶│ queued  │───▶│assigned │
└─────────┘    └─────────┘    └─────────┘
     │                              │
     └──────────────────────────────┘

Active States (nur Cancel erlaubt):
planning, executing, clarifying, waiting_approval

SYSTEM (Agent):
queued ──▶ planning ──▶ executing ──▶ testing ──▶ completed
              │             │
              ▼             ▼
          clarifying    waiting_approval
              │             │
              └──────┬──────┘
                     ▼
                   failed
```

### Kanban Spalten

```
Planung  │  Eingang  │  Zugewiesen  │  In Arbeit  │  Testing  │  Review  │  Erledigt
(planning│   (inbox) │ (queued/     │ (executing/ │(testing)  │ (review) │(completed/
clarify) │           │  assigned)   │ waiting_app)│           │          │failed/cancel)
```

---

## 4. Executor & Tools (`workerExecutor.ts`)

### Verfügbare Tools (6 Stück)

| Tool             | Beschreibung      | Security             |
| ---------------- | ----------------- | -------------------- |
| `shell_execute`  | PowerShell/bash   | ⚠️ Approval-Required |
| `file_read`      | Datei lesen       | ✅                   |
| `write_file`     | Datei schreiben   | ✅                   |
| `browser_fetch`  | URL fetch         | ✅                   |
| `python_execute` | Python ausführen  | ⚠️ Approval-Required |
| `search_web`     | DuckDuckGo Search | ✅                   |

### Tool-Calling Loop

```typescript
for (let loop = 0; loop < MAX_TOOL_LOOPS(10); loop++) {
  // 1. AI dispatch mit Tools
  // 2. Function calls extrahieren
  // 3. Tools ausführen (via dispatcher)
  // 4. Ergebnisse zurück an AI
  // 5. Wenn keine function calls → fertig
}
```

### Persona-Integration

```typescript
// Tools werden gefiltert nach TOOLS.md
const tools = filterToolsByPersona(TOOL_DEFINITIONS, personaContext.allowedTools);

// Runtime-Check pro Tool-Aufruf
if (!isToolAllowed('shell_execute', allowedTools)) {
  throw new Error('Tool not allowed for this persona');
}
```

---

## 5. Orchestra Flow (Alternative zu Standard)

### Wann wird Orchestra verwendet?

```typescript
// Wenn task.flowPublishedId gesetzt ist
if (task.flowPublishedId) {
  await executeOrchestraPhase(task);  // ← Orchestra
} else {
  await executeStandardTaskPhase(...); // ← Standard
}
```

### Orchestra Architektur

```
┌─────────────────────────────────────────────┐
│           Orchestra Flow Graph              │
│  ┌─────┐      ┌─────┐      ┌─────┐         │
│  │Node1│─────▶│Node2│─────▶│Node3│         │
│  │(Dev)│      │(Test)│     │(Deploy)       │
│  └──┬──┘      └─────┘      └─────┘         │
│     │                                       │
│     └──────▶ LLM Routing ────▶ nächster Node│
└─────────────────────────────────────────────┘
```

### Features

- **Visueller Flow-Editor** im UI
- **LLM Routing**: AI entscheidet welcher Node als nächstes
- **Skill-Filter**: Pro Node nur bestimmte Tools erlaubt
- **Persona pro Node**: Jeder Node kann andere Persona nutzen

---

## 6. Code-Qualität Bewertung

### ✅ Stärken

| Bereich                 | Bewertung  | Begründung                                 |
| ----------------------- | ---------- | ------------------------------------------ |
| **Modularität**         | ⭐⭐⭐⭐⭐ | Phase-basierte Architektur, klare Trennung |
| **State Machine**       | ⭐⭐⭐⭐⭐ | Explizite Übergänge, manual vs system      |
| **TypeScript**          | ⭐⭐⭐⭐⭐ | Durchgängige Typisierung                   |
| **Testing**             | ⭐⭐⭐⭐⭐ | 970 Tests, E2E + Unit                      |
| **Persona-Integration** | ⭐⭐⭐⭐⭐ | Dynamische Tool-Filter, Prompt-Injection   |
| **Checkpointing**       | ⭐⭐⭐⭐   | Resume nach Interruption möglich           |
| **Workspace-Isolation** | ⭐⭐⭐⭐   | Jedes Task eigener Ordner                  |

### ⚠️ Schwächen

| Bereich            | Bewertung | Problem                                           |
| ------------------ | --------- | ------------------------------------------------- |
| **Security**       | ⭐⭐⭐    | Shell ohne Sandbox, keine Rate-Limiting           |
| **Error Handling** | ⭐⭐⭐⭐  | Gut, aber könnte mehr Retry-Logik haben           |
| **Concurrency**    | ⭐⭐⭐    | Nur 1 Task parallel (FIFO)                        |
| **Observability**  | ⭐⭐⭐⭐  | Activities gut, aber Metriken könnten besser sein |

### 🔧 Architektur-Highlights

```
workerAgent.ts (82 lines)
├── checkpointPhase.ts    ← Resume-Logik
├── workspacePhase.ts     ← Workspace-Setup
├── orchestraPhase.ts     ← Flow-Ausführung
└── standardTaskPhase.ts  ← Standard-Lifecycle
    ├── Planning
    ├── Execution
    ├── Verification
    ├── Testing
    └── Completion
```

---

## 7. Zusammenfassung

### Funktionsumfang

| Feature                           | Status |
| --------------------------------- | ------ |
| Task erstellen mit Workspace-Type | ✅     |
| AI-Planung (Schritt-Generierung)  | ✅     |
| Step-by-Step Execution            | ✅     |
| Tool-Calling (6 Tools)            | ✅     |
| Shell-Approval System             | ✅     |
| Checkpoint/Resume                 | ✅     |
| Persona-Zuweisung                 | ✅     |
| Orchestra Flows                   | ✅     |
| Webapp-Testing                    | ✅     |
| Activity Logging                  | ✅     |
| Kanban-Board                      | ✅     |
| Live Terminal                     | ✅     |

### Gesamtbewertung: **8.5/10**

Der Worker ist ein gut durchdachtes, modulares System mit klarer Trennung der Verantwortlichkeiten. Die Phase-basierte Architektur macht den Code wartbar und erweiterbar. Die Persona-Integration wurde sauber implementiert. Hauptverbesserungspotenzial liegt bei Security (Sandbox) und Concurrency (mehrere parallele Tasks).

---

## Anhang: Wichtige Dateien

| Datei                   | Beschreibung             | Lines |
| ----------------------- | ------------------------ | ----- |
| `workerAgent.ts`        | Haupt-Orchestrator       | 82    |
| `standardTaskPhase.ts`  | Standard-Task-Lifecycle  | 346   |
| `workerExecutor.ts`     | Tool-Calling & Execution | 533   |
| `workerPlanner.ts`      | AI-Planung               | 82    |
| `workerStateMachine.ts` | Status-Transitions       | 124   |
| `personaIntegration.ts` | Persona-Loading & Filter | 191   |
| `workspaceManager.ts`   | Dateisystem-Operations   | 178   |
| `orchestraPhase.ts`     | Flow-Ausführung          | 227   |
