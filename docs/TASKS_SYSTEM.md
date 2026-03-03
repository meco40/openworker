# Tasks System

## Metadata

- Purpose: Verbindliche Referenz fuer Task-Management und Workspace-Artifakte.
- Scope: Task-Lifecycle, Workspace-Bindung, Artifacts, Completion-Flow.
- Source of Truth: This is the active system documentation for this domain.
- Last Reviewed: 2026-03-03
- Related Runbooks: N/A

---

## 1. Funktionserläuterung

Das Tasks-System verwaltet ausfuehrbare Aufgaben mit Workspace-Bindung und Artifact-Produktion. Tasks koennen manuell oder automatisiert (via Master Agent) erstellt werden.

### Kernkonzepte

- **Task**: Ausfuehrbare Aufgabe mit Titel, Beschreibung, Status und Workspace-Bindung
- **Workspace**: Isolierte Arbeitsumgebung pro Task (Dateien, Outputs, Logs)
- **Artifact**: Produzierte Datei oder Ergebnis eines Tasks
- **Completion**: Task-Abschluss mit Ergebnis-Zusammenfassung

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/tasks/types.ts` - Zentrale Typdefinitionen
- `src/server/tasks/taskRepository.ts` - SQLite-Repository
- `src/server/tasks/taskService.ts` - Business-Logik
- `src/server/tasks/workspaceManager.ts` - Workspace-Verwaltung
- `src/server/tasks/artifactService.ts` - Artifact-Management
- `app/api/tasks/*` - HTTP-Schnittstellen

### 2.2 Datenhaltung

- **Tasks**: `tasks.db` mit Tabellen `tasks`, `task_artifacts`, `task_logs`
- **Workspaces**: Dateibasiert unter `.local/workspaces/<taskId>/`
- **Artifacts**: Metadata in DB, Dateien im Workspace-Verzeichnis

### 2.3 Task-Status

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   PENDING   │ ──▶ │   RUNNING   │ ──▶ │ COMPLETED   │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       │                   ▼                   │
       │            ┌─────────────┐            │
       └───────────▶│   FAILED    │◀───────────┘
                    └─────────────┘
```

---

## 3. API-Referenz

| Methode | Pfad                                  | Zweck                            |
| ------- | ------------------------------------- | -------------------------------- |
| GET     | `/api/tasks`                          | Tasks listen (gefiltert)         |
| POST    | `/api/tasks`                          | Neuen Task erstellen             |
| GET     | `/api/tasks/[id]`                     | Task-Details laden               |
| PATCH   | `/api/tasks/[id]`                     | Task aktualisieren (Status etc.) |
| POST    | `/api/tasks/[id]/complete`            | Task als abgeschlossen markieren |
| GET     | `/api/tasks/workspaces/[workspaceId]` | Alle Tasks eines Workspaces      |

---

## 4. Task-Erstellung

### 4.1 Manuelle Erstellung

```typescript
POST /api/tasks
{
  "title": "Datenanalyse durchfuehren",
  "description": "CSV-Daten importieren und auswerten",
  "workspaceId": "ws_123",
  "priority": "high",
  "metadata": {
    "source": "user",
    "tags": ["analysis", "data"]
  }
}
```

### 4.2 Automatische Erstellung (Master Agent)

Der Master Agent erstellt Tasks im Rahmen von Run-Delegations:

```typescript
POST /api/master/runs/[id]/delegations
{
  "capability": "code_generation",
  "taskPlan": {
    "title": "Feature implementieren",
    "steps": [...]
  }
}
```

---

## 5. Workspace-Management

### 5.1 Workspace-Struktur

```
.local/workspaces/<taskId>/
├── src/           # Quellcode-Dateien
├── output/        # Generierte Outputs
├── logs/          # Ausfuehrungs-Logs
├── artifacts/     # Finale Artefakte
└── metadata.json  # Workspace-Metadaten
```

### 5.2 Workspace-Isolation

- Jeder Task erhaelt einen isolierten Workspace
- Pfadvalidierung verhindert Directory-Traversal
- Workspace-Cwd wird bei Skill-Ausfuehrung gesetzt

---

## 6. Artifact-Management

### 6.1 Artifact-Typen

- **Code**: `.ts`, `.js`, `.py` Dateien
- **Data**: `.csv`, `.json`, `.parquet` Dateien
- **Report**: `.md`, `.pdf` Dokumente
- **Config**: `.yaml`, `.toml` Konfigurationen

### 6.2 Artifact-Registrierung

```typescript
POST /api/tasks/[id]/artifacts
{
  "name": "analyse-report.md",
  "type": "report",
  "path": "artifacts/analyse-report.md",
  "description": "Datenanalyse-Zusammenfassung"
}
```

---

## 7. Integration mit Master Agent

### 7.1 Task-Delegation

Der Master Agent delegiert Capabilities an Tasks:

1. Run wird erstellt mit Capability-Plan
2. Task wird automatisch erstellt
3. Subagenten werden dem Task zugewiesen
4. Ergebnisse werden als Artifacts gespeichert
5. Run wird bei Task-Completion aktualisiert

### 7.2 Approval-Integration

Tasks mit Side-Effects (z.B. `shell_execute`, `gmail.send`) erfordern Approval:

- `approve_once`: Einmalige Freigabe fuer diesen Task
- `approve_always`: Dauerhafte Freigabe fuer diese Capability
- `deny`: Task wird pausiert/benachrichtigt

---

## 8. Konfiguration

| Variable                  | Standard            | Beschreibung                |
| ------------------------- | ------------------- | --------------------------- |
| `TASKS_DB_PATH`           | `.local/tasks.db`   | Pfad zur Tasks-Datenbank    |
| `TASKS_WORKSPACE_ROOT`    | `.local/workspaces` | Root fuer Workspaces        |
| `TASKS_MAX_CONCURRENT`    | `10`                | Maximale parallele Tasks    |
| `TASKS_TIMEOUT_MS`        | `3600000`           | Timeout pro Task (1 Stunde) |
| `TASKS_ARTIFACT_MAX_SIZE` | `10485760`          | Max Artifact-Groesse (10MB) |

---

## 9. Verifikation

```bash
npm run test -- tests/unit/tasks
npm run test -- tests/integration/tasks
npm run typecheck
npm run lint
```

---

## 10. Siehe auch

- `docs/MASTER_AGENT_SYSTEM.md` - Master Agent Delegations
- `docs/PROJECT_WORKSPACE_SYSTEM.md` - Workspace-Isolation
- `docs/SKILLS_SYSTEM.md` - Skill-Ausfuehrung in Tasks
- `docs/API_REFERENCE.md` - Vollstaendige API-Dokumentation
