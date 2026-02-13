# Worker System

**Stand:** 2026-02-13

## Überblick

Das Worker-System ermöglicht autonome KI-Agenten, die komplexe mehrstufige Aufgaben ausführen:
- **Task-Management** mit Zustandsautomaten
- **Tool-Integration** mit Approval-Workflow
- **Workspace-Management** für Datei-Operationen
- **Checkpointing** für Unterbrechung und Wiederaufnahme

## Architektur

```
src/server/worker/
├── workerTypes.ts          # TypeScript-Interfaces
├── workerRepository.ts      # Datenbank-Zugriff
├── workerExecutor.ts        # Einzelschritt-Execution mit Tool-Calling
├── workerPlanner.ts        # Aufgabenplanung (Task → Steps)
├── workerAgent.ts          # High-Level Agent-Orchestrierung
├── workerCallback.ts        # Callback-Handling
├── workspaceManager.ts      # Workspace-Dateiverwaltung
└── workerRowMappers.ts     # DB-Mapping
```

## Task-Zustände

```
queued → planning → clarifying → executing → review → completed
                ↓              ↓           ↓          ↓
            cancelled      waiting_approval   failed   interrupted
```

| Status | Beschreibung |
|--------|--------------|
| `queued` | Task wartet auf Verarbeitung |
| `planning` | KI plant die Task-Schritte |
| `clarifying` | Klärungsfragen an Benutzer |
| `executing` | Task wird ausgeführt |
| `review` | Ergebnisse werden überprüft |
| `completed` | Task erfolgreich abgeschlossen |
| `failed` | Task fehlgeschlagen |
| `cancelled` | Task abgebrochen |
| `interrupted` | Task unterbrochen |
| `waiting_approval` | wartet auf Shell-Command-Genehmigung |

## Task-Prioritäten

| Priorität | Beschreibung |
|----------|--------------|
| `low` | Niedrige Priorität |
| `normal` | Standard-Priorität |
| `high` | Hohe Priorität |
| `urgent` | Dringend |

## Workspace-Typen

- **`general`** – Allgemeiner Arbeitsbereich
- **`code`** – Code-Entwicklung
- **`data`** – Datenanalyse
- **`docs`** – Dokumentationserstellung

## Execution-Modell

Der Worker-Executor führt einen einzelnen Schritt mit vollem Tool-Calling-Loop aus:

```typescript
export async function executeStep(task: WorkerTaskRecord, step: WorkerStepRecord) {
  // 1. System-Prompt mit Task-Kontext
  // 2. AI-Dispatch mit Tool-Definitionen
  // 3. Tool-Calls ausführen
  // 4. Ergebnisse zurückgeben
  // 5. Loop bis AI final response liefert
}
```

### Verfügbare Tools

| Tool | Beschreibung |
|------|--------------|
| `shell_execute` | Shell-Kommando ausführen |
| `file_read` | Datei lesen |
| `write_file` | Datei schreiben |
| `browser_fetch` | URL fetchen |
| `python_execute` | Python-Code ausführen |
| `search_web` | Web-Suche |

## Command Approval

Shell-Kommandos erfordern Genehmigung:

- **`/approve`** – Einmalige Genehmigung
- **`/deny`** – Ablehnen
- **`/approve-always`** – Immer genehmigen (whitelist)

## API-Oberfläche

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| GET | /api/worker | Liste aller Tasks |
| GET | /api/worker/[id] | Task-Details |
| POST | /api/worker | Neue Task erstellen |
| POST | /api/worker/[id]/start | Task starten |
| POST | /api/worker/[id]/stop | Task stoppen |
| GET | /api/worker/[id]/files | Workspace-Dateien |
| POST | /api/worker/[id]/export | Workspace exportieren |

## Verifikation

```bash
npm run test -- tests/unit/worker
npm run test -- tests/integration/worker
npm run lint
npm run typecheck
```

## Siehe auch

- [docs/CORE_HANDBOOK.md](CORE_HANDBOOK.md)
- [docs/SKILLS_SYSTEM.md](SKILLS_SYSTEM.md)
