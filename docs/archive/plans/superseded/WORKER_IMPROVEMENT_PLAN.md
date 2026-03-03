# Worker System — Best-Case Improvement Plan

Das Worker-System wird zu einem vollwertigen **Autonomous Workspace System** umgebaut. Jede Task bekommt einen echten lokalen Ordner mit Dateien — ein isolierter Workspace, in dem der Worker autonom arbeitet.

### Bestätigter Workflow (7 Phasen)

```mermaid
flowchart LR
    A["1. Create"] --> B["2. Plan"]
    B --> C["3. Clarify"]
    C --> D["4. Refine"]
    D --> E["5. Execute"]
    E --> F["6. Self-Verify"]
    F --> G["7. Review"]
    F -.->|"Incomplete"| E
```

1. **Create** — User erstellt Workspace, gibt Aufgabe ein
2. **Plan** — Agent analysiert Aufgabe, erstellt schrittweisen Plan
3. **Clarify** — Agent stellt Rückfragen an den User
4. **Refine** — Agent verfeinert Plan basierend auf Antworten
5. **Execute** — Agent arbeitet Plan Schritt für Schritt ab
6. **Self-Verify** — Agent kontrolliert ob seine Arbeit vollständig und korrekt ist
7. **Review** — Task wird dem User zur Kontrolle vorgelegt

> [!NOTE]
> **Cross-Platform:** Workspace-Pfad wird über `path.join(process.cwd(), 'workspaces', taskId)` aufgebaut — funktioniert auf Windows, Linux und macOS.

---

## Phase 1: Workspace Filesystem Layer

**Kernkonzept:** Jede Task = ein eigener Ordner auf der Festplatte.

```
workspaces/
  └── task-1707600000-abc12345/
      ├── .workspace.json          ← Metadata (status, type, created)
      ├── plan.md                  ← AI-generierter Plan
      ├── output/                  ← Generierte Artefakte
      │   ├── index.html
      │   └── styles.css
      └── logs/                    ← Step-Logs
          ├── step-001.log
          └── step-002.log
```

### Best-Case Workflows:

| Workflow                | Beschreibung                                                    |
| ----------------------- | --------------------------------------------------------------- |
| **File Browser**        | User sieht echte Dateien im Workspace, kann sie direkt öffnen   |
| **Live File Watching**  | Frontend zeigt neue Dateien in Echtzeit an (via SSE)            |
| **Artifact Download**   | Fertige Artefakte als ZIP herunterladen                         |
| **Workspace Cleanup**   | Alte Workspaces löschen                                         |
| **Workspace Resume**    | Bei Neustart: Workspace-Ordner existiert noch → Task fortsetzen |
| **Self-Verification**   | Agent prüft nach Execution automatisch auf Vollständigkeit      |
| **Workspace Forking**   | Bestehenden Workspace kopieren, andere Richtung einschlagen     |
| **Template Workspaces** | Vorlagen-Ordner mit Boilerplate                                 |

### [NEW] `src/server/worker/workspaceManager.ts`

Cross-Platform Filesystem-Service via `path.join()` — kein Hardcoden von `/` oder `\`.

```typescript
import path from 'node:path';
const WORKSPACES_ROOT = path.join(process.cwd(), 'workspaces');

export interface WorkspaceManager {
  createWorkspace(taskId: string, type: WorkspaceType): string;
  getWorkspacePath(taskId: string): string;
  writeFile(taskId: string, relativePath: string, content: string | Buffer): void;
  readFile(taskId: string, relativePath: string): Buffer | null;
  listFiles(taskId: string): WorkspaceFile[];
  deleteWorkspace(taskId: string): void;
  getWorkspaceSize(taskId: string): number;
  exportAsZip(taskId: string): Buffer;
}
```

### [MODIFY] `src/server/worker/workerRepository.ts`

- Neue Spalten: `workspace_path TEXT`, `workspace_type TEXT`
- Methoden: `setWorkspacePath()`, `setWorkspaceType()`

---

## Phase 2: Workspace Type System

> [!IMPORTANT]
> **Aktueller Zustand:** Der `workerExecutor.ts` führt **keine echten Aktionen** aus — er beschreibt nur was er tun _würde_. Skills (shell, filesystem, browser, python, vision, search) existieren, werden aber vom Worker **nicht genutzt**.

### Workspace-Typen (automatisch erkannt via Planner)

| Typ          | Beispiel-Objective                     | Output             | Benötigte Tools             |
| ------------ | -------------------------------------- | ------------------ | --------------------------- |
| **Research** | "Recherchiere nach neuesten Therapien" | PDF, Markdown      | `search`, `browser`, MD→PDF |
| **WebApp**   | "Erstelle eine Webapp für Rezepte"     | Next.js-Projekt    | `shell`, `filesystem`       |
| **Creative** | "Erstelle 5 Social Media Banner"       | Bilder (PNG/JPG)   | `vision`, Image-Gen API     |
| **Data**     | "Analysiere diese CSV-Datei"           | Charts, Reports    | `python`, `sql`             |
| **General**  | "Schreibe mir einen Businessplan"      | Dokumente (MD/PDF) | `filesystem`, `search`      |

### [MODIFY] `src/server/worker/workerTypes.ts`

```typescript
export type WorkspaceType = 'research' | 'webapp' | 'creative' | 'data' | 'general';
```

### [MODIFY] `src/server/worker/workerExecutor.ts`

**Kritischste Änderung** — Executor bekommt echte Tool-Ausführung mit Tool-Calling-Loop:

```typescript
async function executeStep(task, step): Promise<StepResult> {
  // 1. AI entscheidet welche Tools nötig sind (function calling)
  // 2. Tool-Calling-Loop: AI → Tool → AI → Tool → ...
  // 3. Ergebnisse als echte Dateien im Workspace speichern
  // 4. Binärdateien (Bilder, PDFs) → direkt in output/
}
```

### [NEW] `src/server/worker/workspaceScaffold.ts`

Typ-spezifische Ordnerstruktur:

````carousel
```
# Research-Workspace:
workspaces/task-123/
├── .workspace.json
├── sources/        ← Quellen
├── notes/          ← Notizen
└── output/
    └── report.pdf  ← Ergebnis
```
<!-- slide -->
```
# WebApp-Workspace:
workspaces/task-456/
├── .workspace.json
├── app/           ← Next.js App
├── package.json
└── output/
    └── build/     ← Production Build
```
<!-- slide -->
```
# Creative-Workspace:
workspaces/task-789/
├── .workspace.json
├── assets/        ← Input-Material
└── output/
    ├── banner-1.png
    └── banner-2.png
```
````

### Fehlende kritische Features:

| Feature                     | Warum wichtig                                                   |
| --------------------------- | --------------------------------------------------------------- |
| **Binary File I/O**         | Bilder/PDFs als echte Dateien, nicht TEXT in SQLite             |
| **Shell im Workspace**      | `npm install`, `npx create-next-app` mit `cwd` = Workspace-Pfad |
| **Dev-Server Management**   | WebApp-Workspaces brauchen `npm run dev` mit Port-Management    |
| **Typ-spezifische Preview** | PDF-Viewer, Bild-Vorschau, Code-Highlighting, HTML iframe       |
| **MD→PDF Konvertierung**    | Research-Results als downloadbare PDFs                          |
| **Progressiver Output**     | Dateien erscheinen im File Browser _während_ Agent arbeitet     |

---

## Phase 3: Unified Types & API Integration

### [MODIFY] `types.ts`

Frontend-Types an Backend angeglichen:

```diff
 export enum WorkerTaskStatus {
   PLANNING = 'planning',
   CLARIFYING = 'clarifying',
-  IN_PROGRESS = 'in_progress',
+  QUEUED = 'queued',
+  EXECUTING = 'executing',
   REVIEW = 'review',
   COMPLETED = 'completed',
   FAILED = 'failed',
+  CANCELLED = 'cancelled',
+  INTERRUPTED = 'interrupted',
+  WAITING_APPROVAL = 'waiting_approval',
 }

 export interface WorkerTask {
   id: string;
   title: string;
-  prompt: string;
+  objective: string;
   status: WorkerTaskStatus;
+  workspaceType: WorkspaceType;
+  priority: 'low' | 'normal' | 'high' | 'urgent';
+  currentStep: number;
+  totalSteps: number;
+  resultSummary: string | null;
+  errorMessage: string | null;
+  workspacePath: string | null;
+  resumable: boolean;
   createdAt: string;
+  startedAt: string | null;
+  completedAt: string | null;
 }
```

### [NEW] `app/api/worker/[id]/files/route.ts`

- `GET /api/worker/:id/files` → Datei-Listing
- `GET /api/worker/:id/files?path=...` → Datei-Inhalt (Text + Binary via Base64)
- `POST /api/worker/:id/files` → Datei hochladen/ändern

### [MODIFY] `src/server/worker/workerAgent.ts`

1. Workspace mit typ-spezifischem Scaffold erstellen
2. Executor bekommt Workspace-Pfad als `cwd`
3. Artefakte als echte Dateien (inkl. Binär) speichern
4. **Self-Verify:** Bei WebApps → `npm run build`, bei Research → Quellen-Check
5. Bei Research: automatische MD→PDF Konvertierung

---

## Phase 4: Frontend Refactoring

### [DELETE] `WorkerView.tsx`

Aufgeteilt in fokussierte Komponenten:

### [NEW] `components/worker/WorkerTaskList.tsx`

Task-Übersicht mit Workspace-Typ-Badge. Daten via API (`GET /api/worker`).

### [NEW] `components/worker/WorkerTaskCreation.tsx`

Formular mit AI-erkanntem Workspace-Typ, Priority-Selector, Objective-Textarea.

### [NEW] `components/worker/WorkerTaskDetail.tsx`

3 Panels: Flow-Visualisierung, **Workspace File Browser** mit typ-spezifischer Preview, Live Terminal via SSE.

**File Preview nach Typ:**

| Dateiendung            | Preview                      |
| ---------------------- | ---------------------------- |
| `.md`, `.txt`, `.json` | Code-Highlighting mit Syntax |
| `.html`                | iframe-Vorschau              |
| `.pdf`                 | Eingebetteter PDF-Viewer     |
| `.png`, `.jpg`, `.svg` | Bildvorschau                 |
| `.mp4`, `.webm`        | Video-Player                 |
| Sonstige               | Download-Button              |

### [NEW] `src/modules/worker/hooks/useWorkerTasks.ts`

Central Hook: API-Calls, SSE-Subscription, State Management.

### [NEW] `src/modules/worker/hooks/useWorkspaceFiles.ts`

Hook für Workspace-Dateien: Listing, Öffnen, Vorschau.

---

## Phase 5: Best-Case Workflow Features

### Workspace Actions

| Action      | API                                           | Beschreibung                      |
| ----------- | --------------------------------------------- | --------------------------------- |
| **Cancel**  | `PATCH /api/worker/:id { action: 'cancel' }`  | Task abbrechen                    |
| **Resume**  | `PATCH /api/worker/:id { action: 'resume' }`  | Unterbrochenen Task fortsetzen    |
| **Retry**   | `PATCH /api/worker/:id { action: 'retry' }`   | Fehlgeschlagenen Task wiederholen |
| **Approve** | `PATCH /api/worker/:id { action: 'approve' }` | Befehl genehmigen                 |
| **Delete**  | `DELETE /api/worker/:id`                      | Task + Workspace-Ordner löschen   |
| **Export**  | `GET /api/worker/:id/export`                  | Workspace als ZIP                 |

---

## Verification Plan

### Automated Tests

```
npx vitest run tests/unit/worker/workspaceManager.test.ts
npx vitest run tests/workerRepository.test.ts
npx vitest run tests/integration/worker/worker-api-files.test.ts
```

### Manual Verification

1. **Neuen Task erstellen** → Workspace-Ordner unter `workspaces/` prüfen
2. **Research-Task** → PDF im `output/`-Ordner prüfen
3. **WebApp-Task** → `package.json` und Build prüfen
4. **File Browser** → Dateien sichtbar, Preview korrekt
5. **Live-Updates** → Status automatisch aktualisiert (SSE)
6. **Seiten-Reload** → Alle Tasks persistent (SQLite)
7. **Workspace löschen** → Ordner + DB-Eintrag entfernt
