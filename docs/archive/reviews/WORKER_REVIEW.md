# 🔍 Code Review: Autonomos Worker mit Workspace

**Datum:** 2026-02-10  
**Reviewer:** Antigravity AI  
**Scope:** Komplette Worker-Seite (Frontend + Backend)

---

## Gesamtüberblick

Die Worker-Seite besteht aus **12 Dateien** in 4 Schichten:

| Schicht            | Dateien                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend UI**    | `WorkerView.tsx`, `components/WorkerFlow.tsx`, `components/WorkerArtifacts.tsx`                                                                                                                                                     |
| **Frontend Logic** | `src/modules/worker/hooks/useWorkerController.ts`, `src/modules/worker/services/analyzeTask.ts`, `src/modules/worker/services/executeTaskPlan.ts`                                                                                   |
| **API Layer**      | `app/api/worker/route.ts`, `app/api/worker/[id]/route.ts`                                                                                                                                                                           |
| **Backend Engine** | `src/server/worker/workerAgent.ts`, `src/server/worker/workerPlanner.ts`, `src/server/worker/workerExecutor.ts`, `src/server/worker/workerRepository.ts`, `src/server/worker/workerCallback.ts`, `src/server/worker/workerTypes.ts` |

---

## ❌ Ist es auf Best-Case-Prinzip aufgebaut? **Nein.**

Das System ist architektonisch **gespalten** in zwei parallele, inkompatible Implementierungen. Es ist nicht nach dem Best-Case-Prinzip (bestmögliche Architektur, saubere Trennung, Wiederverwendbarkeit) aufgebaut.

---

## 🚨 Kritische Befunde

### 1. Doppelte Architektur — Frontend vs. Backend sind entkoppelt und inkompatibel

| Aspekt           | Frontend (`WorkerView.tsx`)                                              | Backend (`workerAgent.ts`)                                                                                                       |
| ---------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Task-Modell**  | `WorkerTask` (types.ts, Enum-basiert)                                    | `WorkerTaskRecord` (workerTypes.ts, String-Union)                                                                                |
| **Status-Werte** | `planning`, `clarifying`, `in_progress`, `review`, `completed`, `failed` | `queued`, `planning`, `clarifying`, `executing`, `review`, `completed`, `failed`, `cancelled`, `interrupted`, `waiting_approval` |
| **Datenhaltung** | React State (`useState`) — geht bei Reload verloren                      | SQLite-Datenbank — persistent                                                                                                    |
| **AI-Aufrufe**   | Direkt via `ai.models.generateContent()` (Client-Side!)                  | Über `ModelHubService.dispatchWithFallback()` (Server-Side)                                                                      |
| **Execution**    | Sequentielle `for`-Schleife im Browser                                   | Queue-basierter Agent mit Checkpoint-Resume                                                                                      |

**Problem:** Das Frontend ruft AI-Modelle **direkt aus dem Browser** auf (`WorkerView.tsx` Zeile 64-70, `ai.models.generateContent()`), statt die Backend-API zu nutzen. Die gesamte Backend-Infrastruktur (`workerAgent`, `workerPlanner`, `workerExecutor`) wird von der UI **gar nicht verwendet**.

### 2. Kein API-Integration im Frontend

Die `WorkerView.tsx` nutzt **keine einzige** der Backend-Endpunkte:

- Kein `fetch('/api/worker')` (GET Tasks)
- Kein `fetch('/api/worker', { method: 'POST' })` (Create Task)
- Kein `fetch('/api/worker/[id]', { method: 'PATCH' })` (Cancel/Resume/Approve)

Stattdessen wird alles lokal im React State gemanagt und AI wird direkt vom Client aufgerufen.

### 3. God Component — `WorkerView.tsx` (272 Zeilen)

Die gesamte Seite ist eine **einzige monolithische Komponente** mit:

- 7 `useState`-Hooks
- 4 Async-Business-Logic-Funktionen (direkt in der Komponente!)
- 3 verschiedene komplett unterschiedliche Return-Views (Task-Liste, Task-Creation, Task-Detail)
- Keine Trennung von UI und Logik

**Verstoß gegen:** Single Responsibility, Separation of Concerns, Custom Hook-Pattern

### 4. Stale Closure Bug in `executeTaskPlan`

```typescript
// Zeile 78-79
const executeTaskPlan = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId); // ← Stale reference!
```

Die Funktion liest `tasks` aus dem React-State zum Zeitpunkt des Renders, nicht den aktuellen State. Da `setTasks` async ist, kann `task` hier `undefined` oder veraltet sein.

### 5. Fehlendes Error Handling

```typescript
// Zeile 75
} catch (e) { console.error(e); } finally { setIsProcessing(false); }
```

Fehler werden verschluckt — der User sieht **keinerlei Fehlermeldung** in der UI. Kein Error-State, kein Toast, keine Retry-Möglichkeit.

### 6. Security Issue — AI API Key Exposure

`ai.models.generateContent()` (Zeile 64) wird clientseitig aufgerufen. Das bedeutet, der **API-Key muss im Browser verfügbar** sein. Das ist ein Sicherheitsrisiko.

---

## ⚠️ Mittlere Befunde

### 7. Doppelte Type-Definitionen

| Frontend (`types.ts`)                                  | Backend (`workerTypes.ts`)                                    |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `WorkerTaskStatus` (Enum)                              | `WorkerTaskStatus` (String Union)                             |
| `WorkerArtifact` (type: `code\|pdf\|doc\|data\|image`) | `WorkerArtifactRecord` (type: `code\|file\|doc\|image\|data`) |
| `WorkerTask` (prompt-basiert)                          | `WorkerTaskRecord` (objective-basiert)                        |

Die Typen sind semantisch ähnlich, aber syntaktisch inkompatibel. Es gibt **kein Mapping** zwischen ihnen.

### 8. `useWorkerController` Hook — untergenutzt

```typescript
// 23 Zeilen, tut fast nichts:
export function useWorkerController(skills, setTerminalLogs) {
  const activeSkills = useMemo(() => skills.filter((s) => s.installed), [skills]);
  const addTerminalLog = useCallback(
    (cmd, output) => {
      setTerminalLogs((prev) => [...prev, `$ ${cmd}`, `> ${output}`]);
    },
    [setTerminalLogs],
  );
  return { activeSkills, addTerminalLog };
}
```

Dieser Hook ist ein **Wrapper um 2 Zeilen Logik**. Die eigentliche Business-Logik (`analyzeTask`, `executeTaskPlan`, `startNewTask`, `submitAnswer`) bleibt in der View.

### 9. Kein Feedback bei laufenden Tasks

- `isProcessing` State wird gesetzt, aber **nirgends in der UI verwendet** (Zeile 24: `const [, setIsProcessing] = useState(false)` — destrukturiertes Array ignoriert den Wert!).
- Kein Loading-Spinner, kein Skeleton, kein Progress-Indicator.

### 10. WorkerFlow-Komponente — keine dynamischen Updates

`WorkerFlow.tsx` berechnet Steps aus dem statischen `task`-Objekt. Da die Task-Daten nur im Frontend-State leben und nicht gepollt werden, bleibt der Flow-Display statisch nach der initialen Berechnung.

### 11. Terminal Logs sind nicht persistent

```typescript
const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
```

Bei Task-Wechsel oder Page-Reload gehen alle Logs verloren. Die Backend-Infrastruktur für Logging existiert (`workerCallback.ts`), wird aber nicht genutzt.

---

## 📊 Best-Case Bewertung

| Kriterium                  | Score      | Begründung                                   |
| -------------------------- | ---------- | -------------------------------------------- |
| **Separation of Concerns** | 2/10       | God Component, Business-Logik in View        |
| **Type Safety**            | 3/10       | Doppelte, inkompatible Typen                 |
| **State Management**       | 2/10       | Volatiler useState, kein Backend-Sync        |
| **Error Handling**         | 1/10       | Fehler werden verschluckt                    |
| **Security**               | 2/10       | Client-Side AI-Aufrufe                       |
| **Code Reuse**             | 3/10       | Backend existiert, wird nicht genutzt        |
| **UX/Feedback**            | 3/10       | Kein Loading, kein Error State               |
| **Persistence**            | 2/10       | Daten gehen bei Reload verloren              |
| **Testability**            | 2/10       | Monolithisch, schwer isoliert testbar        |
| **UI Design**              | 7/10       | Visuell gut designt (Dark Theme, Animations) |
| **Gesamt**                 | **2.7/10** |                                              |

---

## 🎯 Empfohlene Maßnahmen (nach Priorität)

### Prio 1 — Frontend mit Backend API verbinden

1. Die `analyzeTask` und `executeTaskPlan` Funktionen müssen API-Calls an `/api/worker` machen statt `ai.models.generateContent()` direkt aufzurufen
2. Typen vereinheitlichen — entweder `types.ts` oder `workerTypes.ts`, nicht beides

### Prio 2 — WorkerView aufbrechen

1. `WorkerTaskList` — Task-Übersicht
2. `WorkerTaskCreation` — Provisioning-Formular
3. `WorkerTaskDetail` — Detail-Ansicht mit Flow + Terminal + Artifacts
4. `useWorkerTasks` Hook — API-Integration, State-Management, Polling

### Prio 3 — UX-Verbesserungen

1. Loading-States für async Operationen sichtbar machen
2. Error-Boundaries und User-freundliche Fehlermeldungen
3. SSE-basierte Live-Updates (Backend unterstützt es bereits via `broadcastStatus`)
4. Persistent Terminal Logs von der API
