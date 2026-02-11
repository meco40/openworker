# 🏗️ Architektur v3: Command-Based Worker-Delegation

> **Datum:** 10. Februar 2026 | **Revision:** v3  
> **Kern-Änderung:** User steuert explizit per Befehl statt AI-Intent-Klassifikation

---

## Konzept: Explizite Befehle statt KI-Entscheidung

### Warum?

|                  | v2 (AI-Intent)                                  | v3 (Command-Based) ✅             |
| ---------------- | ----------------------------------------------- | --------------------------------- |
| **Token-Kosten** | Jede Nachricht braucht Klassifikation           | Kein Extra-Token-Verbrauch        |
| **Prompt-Größe** | Große System-Instruction mit Entscheidungslogik | Schlanker Prompt, klare Rolle     |
| **Fehlerquote**  | AI kann Frage als Aufgabe klassifizieren        | 0% Fehler — User entscheidet      |
| **Latenz**       | AI muss erst nachdenken                         | Sofortiges Routing (String-Check) |
| **UX**           | User weiß nicht was passiert                    | User hat volle Kontrolle          |

### Der neue Flow

```
User-Nachricht kommt an (Telegram, WebChat, etc.)
         │
         ▼
┌─────────────────────────────────────────┐
│  MESSAGE ROUTER (deterministisch!)       │
│                                          │
│  Startet mit "@worker" oder "/worker"?   │
│                                          │
│  NEIN ──► 🧠 Chat-Agent (wie bisher)    │
│           Sofort antworten, Memory,      │
│           Tools inline, Scheduling       │
│                                          │
│  JA ────► ⚙️ Worker-Engine              │
│           Task erstellen, planen,        │
│           ausführen, zurückmelden        │
└─────────────────────────────────────────┘
```

### Unterstützte Befehls-Formate

```
BEFEHL                              ERGEBNIS
────────────────────────────────    ──────────────────────────────────
@worker Erstelle eine Notiz-App     → Worker-Task: "Erstelle eine Notiz-App"
/worker Analysiere meine PDFs       → Worker-Task: "Analysiere meine PDFs"
@Worker Schreib Unit-Tests           → Case-insensitive, funktioniert auch

/worker-status                       → Zeigt aktive Tasks
/worker-status task-abc123          → Status eines bestimmten Tasks
/worker-cancel task-abc123          → Task abbrechen
/worker-list                         → Alle Tasks auflisten
```

---

## Technische Umsetzung

### 1. Message-Router (Server-seitig, ~50 Zeilen)

```typescript
// src/server/channels/messages/messageRouter.ts (NEU)

const WORKER_PREFIXES = ['@worker ', '/worker '];
const WORKER_COMMANDS = ['/worker-status', '/worker-cancel', '/worker-list'];

export function routeMessage(content: string): {
  target: 'chat' | 'worker' | 'worker-command';
  payload: string;
  command?: string;
} {
  const lower = content.toLowerCase().trim();

  // Worker-Befehle (Status, Cancel, List)
  for (const cmd of WORKER_COMMANDS) {
    if (lower.startsWith(cmd)) {
      return { target: 'worker-command', payload: content.slice(cmd.length).trim(), command: cmd };
    }
  }

  // Worker-Task-Delegation
  for (const prefix of WORKER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { target: 'worker', payload: content.slice(prefix.length).trim() };
    }
  }

  // Alles andere → normaler Chat
  return { target: 'chat', payload: content };
}
```

### 2. Integration in MessageService

```typescript
// src/server/channels/messages/service.ts — handleInbound() erweitern

async handleInbound(platform, externalChatId, content, ...) {
  const route = routeMessage(content);

  switch (route.target) {
    case 'chat':
      // Wie bisher: AI-Dispatch, Antwort, SSE
      return this.handleChatMessage(conversation, route.payload, platform);

    case 'worker':
      // NEU: Task erstellen, Worker starten, Bestätigung senden
      return this.handleWorkerTask(conversation, route.payload, platform, externalChatId);

    case 'worker-command':
      // NEU: Status/Cancel/List Befehle
      return this.handleWorkerCommand(conversation, route.command, route.payload, platform);
  }
}

private async handleWorkerTask(conversation, objective, platform, externalChatId) {
  // 1. Task in DB erstellen
  const task = await workerRepo.createTask({
    title: objective.slice(0, 60),
    objective,
    status: 'queued',
    originPlatform: platform,
    originConversation: conversation.id,
    originExternalChat: externalChatId,
  });

  // 2. Bestätigung an User
  const confirmMsg = `⚙️ Task erstellt: "${task.title}"\nID: ${task.id}\nStatus: Wird bearbeitet...\n\n📋 /worker-status ${task.id}`;

  // 3. Worker im Hintergrund starten
  startWorkerAgent(task.id); // Fire & Forget

  return { userMsg, agentMsg: this.saveAndBroadcast(conversation.id, 'agent', confirmMsg, platform) };
}
```

### 3. Worker-Engine (Server-seitig)

```
src/server/worker/
  ├── workerAgent.ts        ← Hauptlogik: Plan → Execute → Report
  ├── workerPlanner.ts      ← Task analysieren, Schritte planen
  ├── workerExecutor.ts     ← ReAct-Loop pro Schritt (Tool-Calls)
  ├── workerRepository.ts   ← SQLite CRUD für Tasks/Steps/Artifacts
  └── workerCallback.ts     ← Rückmeldung an User via Chat
```

**workerAgent.ts (Kern-Loop):**

```typescript
export async function startWorkerAgent(taskId: string) {
  // Fire & Forget — läuft im Hintergrund
  runWorkerAgent(taskId).catch((err) => {
    workerRepo.updateStatus(taskId, 'failed', err.message);
  });
}

async function runWorkerAgent(taskId: string) {
  const task = workerRepo.getTask(taskId);

  // 1. PLANEN
  workerRepo.updateStatus(taskId, 'planning');
  broadcastWorkerStatus(taskId, 'planning');
  const plan = await planTask(task); // AI: Schritte definieren
  workerRepo.saveSteps(taskId, plan.steps);

  // 2. AUSFÜHREN (pro Schritt)
  for (let i = 0; i < plan.steps.length; i++) {
    workerRepo.updateStatus(taskId, 'executing', { stepIndex: i });
    broadcastWorkerStatus(taskId, 'executing', i);

    const result = await executeStep(task, plan.steps[i], availableTools);
    workerRepo.saveStepResult(taskId, i, result);

    if (result.failed) {
      workerRepo.updateStatus(taskId, 'failed', result.error);
      await notifyUser(task, `❌ Task fehlgeschlagen bei Schritt ${i + 1}: ${result.error}`);
      return;
    }
  }

  // 3. FINALISIEREN & ZURÜCKMELDEN
  const summary = await synthesizeResults(task);
  workerRepo.updateStatus(taskId, 'completed', { summary });
  await notifyUser(task, `✅ Task "${task.title}" abgeschlossen!\n\n${summary}`);
}
```

### 4. Rückmeldung an User

```typescript
// src/server/worker/workerCallback.ts

async function notifyUser(task: WorkerTask, message: string) {
  const msgService = getMessageService();

  // 1. In Conversation speichern + SSE broadcast
  msgService.saveDirectMessage(task.originConversation, 'agent', message, task.originPlatform);

  // 2. An externen Kanal senden (Telegram, WhatsApp, etc.)
  if (task.originPlatform !== 'WebChat') {
    await deliverOutbound(task.originPlatform, task.originExternalChat, message);
  }
}
```

### 5. SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS worker_tasks (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  objective            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued',
  priority             TEXT NOT NULL DEFAULT 'normal',
  origin_platform      TEXT NOT NULL,
  origin_conversation  TEXT NOT NULL,
  origin_external_chat TEXT,
  current_step         INTEGER DEFAULT 0,
  result_summary       TEXT,
  error_message        TEXT,
  created_at           TEXT NOT NULL,
  completed_at         TEXT
);

CREATE TABLE IF NOT EXISTS worker_steps (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  step_index INTEGER NOT NULL, description TEXT NOT NULL,
  status TEXT DEFAULT 'pending', output TEXT,
  tool_calls TEXT, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS worker_artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  name TEXT NOT NULL, type TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL
);
```

---

## Beispiel-Szenarien

### Szenario 1: Normale Chat-Nachricht (kein @worker)

```
User (Telegram): "Wie wird das Wetter morgen?"
→ routeMessage() → target: 'chat'
→ Normaler AI-Dispatch wie bisher
→ Chat antwortet sofort
```

### Szenario 2: Worker-Aufgabe

```
User (Telegram): "@worker Erstelle eine Notiz-WebSeite mit React"

→ routeMessage() → target: 'worker', payload: "Erstelle eine Notiz-WebSeite mit React"

Chat antwortet sofort:
  "⚙️ Task erstellt: "Erstelle eine Notiz-WebSeite mit React"
   ID: task-abc123
   Status: Wird bearbeitet...
   📋 /worker-status task-abc123"

Worker läuft im Hintergrund (server-seitig):
  [planning] → [executing 1/5] → ... → [completed]

User bekommt Telegram-Nachricht:
  "✅ Task "Erstelle eine Notiz-WebSeite mit React" abgeschlossen!
   • React-App mit TypeScript erstellt
   • CRUD für Notizen implementiert
   • Dark Mode Styling
   Details im Workspace."
```

### Szenario 3: Status abfragen

```
User: "/worker-status"
→ "📋 Aktive Tasks:
    1. ⚙️ Erstelle eine Notiz-WebSeite (Step 3/5)
    2. ✅ Unit-Tests schreiben (fertig)"

User: "/worker-cancel task-abc123"
→ "🛑 Task abgebrochen."
```

---

## Was sich gegenüber v2 VEREINFACHT

```
ENTFÄLLT KOMPLETT:
  ❌ Intent-Classifier (AI-basiert)
  ❌ delegate_task Tool (Function-Calling)
  ❌ Erweiterte System-Instruction (Orchestrator-Rolle)
  ❌ AI muss zwischen Frage/Aufgabe entscheiden

WIRD ERSETZT DURCH:
  ✅ 1 Funktion: routeMessage() (~50 Zeilen, deterministisch)
  ✅ String-Prefix-Check: "@worker" oder "/worker"
  ✅ 0 Token-Kosten für Routing
  ✅ 0% Fehlerquote
  ✅ User hat volle Kontrolle
```

---

## Implementierungs-Plan

```
PHASE  WAS                              DATEIEN                         AUFWAND
─────  ──────────────────────────────  ───────────────────────────────  ──────
  1    Message-Router                   messages/messageRouter.ts        2 Std
       (String-Prefix → target)

  2    Worker-Repository (SQLite)       server/worker/workerRepo.ts      0.5 Tag
       (Tasks, Steps, Artifacts)        api/worker/route.ts

  3    MessageService erweitern         messages/service.ts              0.5 Tag
       (handleWorkerTask)

  4    Worker-Agent (Server-seitig)     server/worker/workerAgent.ts     2-3 Tage
       Plan → Execute → Report         server/worker/workerPlanner.ts
                                        server/worker/workerExecutor.ts

  5    Worker-Callback                  server/worker/workerCallback.ts  2 Std
       (Rückmeldung an User)

  6    Worker-Commands                  messages/service.ts              0.5 Tag
       (/worker-status, -cancel, -list)

  7    WorkerView.tsx → Dashboard       WorkerView.tsx                   1 Tag
       (liest aus API statt eigener AI)
                                                          GESAMT: ~5 Tage
```

**Bereit zum Implementieren — Phase 1 (Message-Router) kann sofort starten.**
