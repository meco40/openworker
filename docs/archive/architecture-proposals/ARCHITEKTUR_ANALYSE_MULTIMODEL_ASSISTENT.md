# 🏗️ Architektur-Analyse: Multi-Model Persönlicher Assistent (v2 – Verfeinert)

> **Datum:** 10. Februar 2026  
> **Revision:** v2 – Verfeinerung Super-Intelligenz + Worker-Delegation  
> **Aktueller Stand:** OpenClaw Gateway v1.2.5

---

## 1. Das verfeinerte Konzept

### Kern-Idee: Chat-Agent als **Super-Intelligenz**, Worker als **Ausführungs-Engine**

```
                         ┌─────────────────────────────┐
                         │      USER                    │
                         │  (Telegram, WebChat, etc.)   │
                         └──────────┬──────────────────┘
                                    │
                                    │ "Erstelle mir eine WebSeite für Notizen"
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│                    🧠 SUPER-INTELLIGENZ (Chat Agent)                     │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │                    INTENT-KLASSIFIKATION                         │   │
│   │                                                                  │   │
│   │   "Ist das eine Frage oder eine Aufgabe?"                       │   │
│   │                                                                  │   │
│   │   ┌─────────────────────────┐  ┌─────────────────────────────┐  │   │
│   │   │ 💬 DIREKT-ANTWORT       │  │ 🔨 AUFGABE → WORKER         │  │   │
│   │   │                         │  │                             │  │   │
│   │   │ • "Wie heißt du?"       │  │ • "Erstelle eine Website"  │  │   │
│   │   │ • "Was ist React?"      │  │ • "Analysiere meine PDFs"  │  │   │
│   │   │ • "Erinnere mich um 5"  │  │ • "Schreib ein Script"     │  │   │
│   │   │ • "Wie wird das Wetter" │  │ • "Refactore den Code"     │  │   │
│   │   │                         │  │ • "Erstelle einen Report"   │  │   │
│   │   │ → Sofort antworten      │  │                             │  │   │
│   │   │ → Memory nutzen         │  │ → An Worker delegieren      │  │   │
│   │   │ → Tools inline nutzen   │  │ → User informieren          │  │   │
│   │   └─────────────────────────┘  └──────────────┬──────────────┘  │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                    │                     │
│   Chat antwortet sofort:                           │                     │
│   "Ich erstelle dir eine Webseite für Notizen.     │                     │
│    Ich richte einen Workspace ein und arbeite       │                     │
│    daran. Du bekommst Bescheid wenn es fertig ist." │                     │
│                                                    │                     │
└──────────────────────────────────────────────────────────────────────────┘
                                                     │
                                     "delegate_task" │ (neues Core-Tool)
                                                     │
                                                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│                   ⚙️ WORKER ENGINE (Autonomer Agent)                     │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ STEP 1: WORKSPACE ERSTELLEN                                      │   │
│   │   • Task anlegen (SQLite)                                        │   │
│   │   • Skills laden                                                 │   │
│   │   • Kontext aufbauen (Memory-Recall)                             │   │
│   └───────────────────────────┬──────────────────────────────────────┘   │
│                               ▼                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ STEP 2: PLANEN                                                   │   │
│   │   • Aufgabe analysieren                                          │   │
│   │   • Schritte definieren                                          │   │
│   │   • Benötigte Tools identifizieren                               │   │
│   │   • (Optional: Rückfragen an User)                               │   │
│   └───────────────────────────┬──────────────────────────────────────┘   │
│                               ▼                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ STEP 3: AUSFÜHREN (Agent-Loop)                                   │   │
│   │   • Schritt für Schritt abarbeiten                               │   │
│   │   • Tools aufrufen (Shell, FS, API, Browser...)                  │   │
│   │   • Ergebnisse auswerten                                         │   │
│   │   • Bei Fehler: Selbstkorrektur                                  │   │
│   │   • Artefakte sammeln                                            │   │
│   └───────────────────────────┬──────────────────────────────────────┘   │
│                               ▼                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ STEP 4: REVIEW → RÜCKMELDUNG AN SUPER-INTELLIGENZ               │   │
│   │   • Ergebnis zusammenfassen                                      │   │
│   │   • Status: "Aufgabe erledigt"                                   │   │
│   │   • Artefakte: Links, Code, Dateien                              │   │
│   └───────────────────────────┬──────────────────────────────────────┘   │
│                               │                                          │
└───────────────────────────────┼──────────────────────────────────────────┘
                                │
                    "task_completed" Event (SSE)
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│                    🧠 SUPER-INTELLIGENZ (Chat Agent)                     │
│                                                                          │
│   Empfängt Ergebnis und informiert den User:                             │
│                                                                          │
│   "✅ Deine Notiz-Webseite ist fertig!                                   │
│    Ich habe einen einfachen Notiz-Editor mit React gebaut.               │
│    Features: Erstellen, Bearbeiten, Löschen, LocalStorage.              │
│    → Details und Artefakte findest du im Workspace."                     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. IST vs SOLL: Was muss sich ändern?

### 2.1 Aktueller Flow (IST)

```
PROBLEM: Zwei getrennte Welten, die nicht kommunizieren

                WebChat/Telegram
                      │
          ┌───────────┴───────────┐
          │                       │
          ▼                       ▼
    ┌──────────┐           ┌──────────────┐
    │ Chat     │           │ Worker View  │
    │ Agent    │           │ (manuell)    │
    │          │     ✗     │              │
    │ Antwort- │◄ ─ ─ ─ ─►│ Task anlegen │  ← User muss MANUELL
    │ maschine │   keine   │ Task starten │     zur Worker-View
    │          │   Verb.   │ Task reviewen│     navigieren
    └──────────┘           └──────────────┘

    • Chat beantwortet alles inline
    • Kein Unterschied zwischen Frage und Aufgabe
    • Worker nur über UI erreichbar (nicht via Chat/Telegram)
    • Chat weiß nichts vom Worker
    • Worker meldet nichts zurück an Chat
```

### 2.2 Neuer Flow (SOLL)

```
                Telegram / WebChat / WhatsApp
                         │
                         ▼
                ┌────────────────┐
                │ Message-Service│ (existiert ✅)
                └───────┬────────┘
                        │
                        ▼
           ┌─────────────────────────┐
           │  🧠 SUPER-INTELLIGENZ    │
           │  (Chat Agent)           │
           │                         │
           │  "Ist das eine Frage    │
           │   oder eine Aufgabe?"   │
           └───────┬─────────┬───────┘
                   │         │
         Frage ◄───┘         └───► Aufgabe
                   │                   │
                   ▼                   ▼
          ┌──────────────┐    ┌──────────────────┐
          │ Direkt-       │   │ delegate_task()   │
          │ Antwort       │   │                   │
          │ (wie bisher)  │   │ • Task erstellen  │
          │               │   │ • Worker starten  │
          └──────────────┘    │ • User informieren│
                              └────────┬─────────┘
                                       │
                              ┌────────▼─────────┐
                              │  ⚙️ WORKER ENGINE │
                              │  (Server-Seitig!) │
                              │                   │
                              │  Plan → Execute → │
                              │  → Observe →      │
                              │  → Next Step →    │
                              │  → Review         │
                              └────────┬─────────┘
                                       │
                              task_completed Event
                                       │
                              ┌────────▼─────────┐
                              │  🧠 SUPER-INT.    │
                              │  Fasst zusammen   │
                              │  und antwortet     │
                              │  im Chat           │
                              └────────┬─────────┘
                                       │
                              ┌────────▼─────────┐
                              │  📱 Telegram/     │
                              │  WebChat/etc.     │
                              │                   │
                              │  "Aufgabe fertig! │
                              │   Details im      │
                              │   Workspace"      │
                              └──────────────────┘
```

---

## 3. Architektur-Delta: Was muss gebaut werden?

### 3.1 Übersicht – 5 neue Bausteine

```
┌──────────────────────────────────────────────────────────────────────┐
│                     NEUE BAUSTEINE                                   │
│                                                                      │
│  ┌─── ① ──────────────────────────────────────────────────────────┐ │
│  │ INTENT CLASSIFIER                                               │ │
│  │ Neues Core-Tool für den Chat-Agent                              │ │
│  │ → Entscheidet: Frage oder Aufgabe?                              │ │
│  │ → Bei Aufgabe: ruft delegate_task() auf                         │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─── ② ──────────────────────────────────────────────────────────┐ │
│  │ DELEGATE_TASK TOOL                                              │ │
│  │ Neues Function-Calling Tool im Chat-Agent                       │ │
│  │ → Erstellt Task + Workspace                                     │ │
│  │ → Startet Worker-Engine im Hintergrund                          │ │
│  │ → Gibt dem User sofort eine Bestätigung                         │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─── ③ ──────────────────────────────────────────────────────────┐ │
│  │ SERVER-SEITIGER WORKER-AGENT                                    │ │
│  │ Aktuell läuft der Worker rein im Frontend (WorkerView.tsx)      │ │
│  │ → Muss auf den Server verlagert werden                          │ │
│  │ → Server-seitiger Agent-Loop mit Tool-Zugriff                   │ │
│  │ → Läuft asynchron im Hintergrund                                │ │
│  │ → Streamt Status-Updates via SSE                                │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─── ④ ──────────────────────────────────────────────────────────┐ │
│  │ TASK-COMPLETION CALLBACK                                        │ │
│  │ Wenn Worker fertig:                                             │ │
│  │ → Event an Super-Intelligenz                                    │ │
│  │ → Super-Intelligenz formuliert Antwort                          │ │
│  │ → Sendet Antwort an den Original-Kanal (Telegram etc.)          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─── ⑤ ──────────────────────────────────────────────────────────┐ │
│  │ TASK PERSISTENCE (SQLite)                                       │ │
│  │ Worker-Tasks müssen persistiert werden                          │ │
│  │ → Status, Schritte, Artefakte, Logs                             │ │
│  │ → Überlebt Server-Neustart                                      │ │
│  │ → Frontend (WorkerView) liest nur noch aus DB                   │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. Detailliertes Design pro Baustein

### ① Intent-Klassifikation: Erweiterung der System-Instruction

**Aktuell** (`services/gateway.ts` Zeile 222-235):

```
System-Instruction = "Du bist der OpenClaw Gateway Proactive Agent..."
→ Keine Unterscheidung zwischen Frage und Aufgabe
→ Alles wird inline beantwortet
```

**NEU:** Die System-Instruction bekommt eine klare Rollendefinition:

```typescript
// services/gateway.ts — ERWEITERTE SYSTEM INSTRUCTION

export const SYSTEM_INSTRUCTION = `
Du bist die OpenClaw Super-Intelligenz — der zentrale Koordinator eines
persönlichen Assistenten-Systems.

═══════════════════════════════════════════════════════
DEINE ROLLE: ENTSCHEIDER & ORCHESTRATOR
═══════════════════════════════════════════════════════

Für JEDE eingehende Nachricht entscheidest du:

┌─────────────────────────────────────────────────────┐
│ TYP A: DIREKTE ANTWORT                              │
│                                                     │
│ Wenn die Nachricht eine:                            │
│  • Frage ist ("Was ist X?", "Wie geht Y?")          │
│  • Kurze Bitte ("Erinnere mich an...", "Übersetze")  │
│  • Konversation ("Danke", "Wie geht's dir?")        │
│  • Einfache Tool-Nutzung (Suche, Memory)            │
│                                                     │
│ → Beantworte SOFORT mit deinem Wissen & Tools       │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ TYP B: AUFGABE → WORKER DELEGIEREN                  │
│                                                     │
│ Wenn die Nachricht eine:                            │
│  • Komplexe Aufgabe ist ("Erstelle...", "Baue...")   │
│  • Multi-Step-Arbeit erfordert                      │
│  • Dateien/Code erzeugen soll                       │
│  • Recherche + Synthese braucht                     │
│  • Längere Ausführungszeit hat (> 30 Sekunden)      │
│                                                     │
│ → Nutze das Tool 'delegate_task'                    │
│ → Sage dem User: Aufgabe wird bearbeitet            │
│ → Der Worker meldet sich wenn fertig                │
└─────────────────────────────────────────────────────┘

PROAKTIVES LERNEN:
- Nutze 'core_memory_store' um Präferenzen zu speichern
- Nutze 'core_memory_recall' zu Beginn JEDER Interaktion
- Erkenne Termine → 'core_task_schedule'

RÜCKMELDUNGEN VOM WORKER:
Wenn du eine Nachricht vom System bekommst, dass ein Task fertig ist,
formuliere eine natürliche Antwort für den User mit den wichtigsten
Ergebnissen und verweise auf den Workspace für Details.

Aktuelles Datum/Zeit: ${new Date().toLocaleString()}
`;
```

**Aufwand:** ~1 Stunde (nur Text-Änderung)

---

### ② `delegate_task` – Neues Core-Tool

**Wo:** Als neues Core-Tool neben `core_memory_store`, `core_memory_recall`, `core_task_schedule`

```typescript
// core/worker/index.ts (NEU)

// Tool-Definition für den Chat-Agent (Function Calling)
export const DELEGATE_TASK_TOOL = {
  name: 'delegate_task',
  description: `Delegiere eine komplexe Aufgabe an den Worker-Engine. 
    Nutze dieses Tool wenn der User eine Aufgabe gibt die mehrere 
    Schritte erfordert, Code/Dateien erzeugt werden sollen, oder 
    die Ausführung länger dauert. Der Worker arbeitet autonom im 
    Hintergrund und meldet das Ergebnis zurück.`,
  parameters: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string' as const,
        description: 'Kurzer Titel der Aufgabe (max 60 Zeichen)',
      },
      objective: {
        type: 'string' as const,
        description: `Detaillierte Beschreibung der Aufgabe. Beinhalte alle 
          relevanten Details die der User genannt hat. Der Worker sieht 
          NUR dieses Objective, nicht den Chat-Verlauf.`,
      },
      priority: {
        type: 'string' as const,
        description: 'Priorität der Aufgabe',
        enum: ['low', 'normal', 'high', 'urgent'],
      },
    },
    required: ['title', 'objective'],
  },
};

// Handler: Wird aufgerufen wenn der Chat-Agent delegate_task nutzt
export async function handleDelegateTask(args: {
  title: string;
  objective: string;
  priority?: string;
  platform: string; // von welchem Kanal kam die Nachricht
  conversationId: string; // damit wir die Antwort zurück senden können
}): Promise<{ taskId: string; status: string }> {
  // 1. Task in SQLite erstellen
  const task = await createWorkerTask({
    title: args.title,
    objective: args.objective,
    priority: args.priority || 'normal',
    originPlatform: args.platform,
    originConversationId: args.conversationId,
    status: 'queued',
  });

  // 2. Worker-Engine im Hintergrund starten (Fire & Forget)
  //    Der Worker läuft server-seitig und meldet sich via Event
  startWorkerAgent(task.id); // Non-blocking!

  // 3. Sofortige Bestätigung an den Chat-Agent
  return {
    taskId: task.id,
    status: 'queued',
  };
}
```

**Integration in `useAgentRuntime.ts`:**

```typescript
// Neuer Fall neben core_memory_store, core_task_schedule:

if (functionCall.name === 'delegate_task') {
  const result = await handleDelegateTask({
    ...functionCall.args,
    platform, // von welchem Kanal
    conversationId: activeConversationId,
  });

  addEventLog('TASK', `Worker-Task erstellt: ${result.taskId}`);
  toolOutputs.push({
    name: 'delegate_task',
    result: {
      status: 'Task wurde erstellt und wird bearbeitet.',
      taskId: result.taskId,
    },
  });
}
```

**Aufwand:** ~0.5 Tage

---

### ③ Server-seitiger Worker-Agent (Kern-Stück)

**Aktuelles Problem:**
Der Worker läuft komplett im **Frontend** (`WorkerView.tsx`):

- `analyzeTask()` → Frontend ruft `ai.models.generateContent()` direkt auf
- `executeTaskPlan()` → Frontend iteriert Schritte und ruft AI pro Schritt auf
- Kein echtes Tool-Calling (kein `shell_execute`, `file_read` etc.)
- User muss die Worker-View offen haben → schließt er den Tab, stoppt alles

**Neues Design — Server-seitiger Agent:**

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│          SERVER-SEITIGER WORKER-AGENT                            │
│          src/server/worker/                                       │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    workerAgent.ts                           │  │
│  │                                                            │  │
│  │  async function runWorkerAgent(taskId: string) {           │  │
│  │                                                            │  │
│  │    // 1. Task aus DB laden                                 │  │
│  │    const task = await loadTask(taskId);                     │  │
│  │                                                            │  │
│  │    // 2. PLANEN                                            │  │
│  │    updateStatus(taskId, 'planning');                        │  │
│  │    broadcastStatus(taskId, 'planning');                     │  │
│  │    const plan = await planTask(task);                       │  │
│  │                                                            │  │
│  │    // 3. AUSFÜHREN (Step-by-Step mit Agent-Loop)            │  │
│  │    for (const step of plan.steps) {                         │  │
│  │      updateStatus(taskId, 'executing', step);               │  │
│  │      broadcastStatus(taskId, 'executing', step);            │  │
│  │                                                            │  │
│  │      // Agent-Loop pro Schritt:                             │  │
│  │      // Model entscheidet welche Tools es braucht           │  │
│  │      // → ruft shell_execute, file_write, etc. auf          │  │
│  │      // → beobachtet Ergebnis                               │  │
│  │      // → entscheidet: nochmal oder weiter?                 │  │
│  │      const result = await executeStep(task, step, tools);   │  │
│  │      saveStepResult(taskId, step, result);                  │  │
│  │    }                                                        │  │
│  │                                                            │  │
│  │    // 4. FINALISIEREN                                       │  │
│  │    const summary = await synthesizeResults(task);           │  │
│  │    updateStatus(taskId, 'review', summary);                 │  │
│  │                                                            │  │
│  │    // 5. RÜCKMELDUNG AN SUPER-INTELLIGENZ                  │  │
│  │    await notifySuperAgent(task, summary);                   │  │
│  │  }                                                          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ workerPlanner.ts │  │ workerExecutor.ts│                     │
│  │                  │  │                  │                     │
│  │ • Aufgabe        │  │ • ReAct-Loop     │                     │
│  │   analysieren    │  │   pro Schritt    │                     │
│  │ • Plan erstellen │  │ • Tool-Calls     │                     │
│  │ • Skills matchen │  │ • Beobachtung    │                     │
│  │ • Rückfragen?    │  │ • Selbstkorrektur│                     │
│  └──────────────────┘  └──────────────────┘                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ workerRepository.ts (SQLite)                             │   │
│  │                                                          │   │
│  │ Tables:                                                  │   │
│  │  • worker_tasks (id, title, objective, status, ...)      │   │
│  │  • worker_steps (task_id, step_index, description, ...)  │   │
│  │  • worker_artifacts (task_id, name, type, content)       │   │
│  │  • worker_logs (task_id, timestamp, level, message)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Aufwand:** ~2-3 Tage

---

### ④ Task-Completion Callback

**Flow wenn Worker fertig ist:**

```typescript
// src/server/worker/workerAgent.ts

async function notifySuperAgent(task: WorkerTaskRecord, summary: string) {
  // 1. Ergebnis-Nachricht bauen
  const completionMessage = {
    taskId: task.id,
    title: task.title,
    status: 'completed',
    summary: summary,
    artifactCount: task.artifacts.length,
    duration: calculateDuration(task),
  };

  // 2. System-Nachricht in die Original-Conversation einfügen
  const messageService = getMessageService();
  messageService.saveDirectMessage(
    task.originConversationId,
    'system',
    `[TASK_COMPLETED] ${JSON.stringify(completionMessage)}`,
    task.originPlatform,
  );

  // 3. Super-Intelligenz antwortet dem User
  //    Option A: Automatische Zusammenfassung via AI
  const service = getModelHubService();
  const result = await service.dispatchWithFallback('p1', getEncryptionKey(), {
    messages: [
      {
        role: 'system',
        content: `Der Worker hat einen Task abgeschlossen. Formuliere eine 
          natürliche, kurze Antwort für den User. Verweise auf den Workspace 
          für Details.`,
      },
      {
        role: 'user',
        content: `Task "${task.title}" ist fertig.\n\nZusammenfassung:\n${summary}\n\nArtefakte: ${task.artifacts.length} Dateien erstellt.`,
      },
    ],
  });

  const agentResponse = result.ok
    ? result.text
    : `✅ Dein Task "${task.title}" ist abgeschlossen. Details findest du im Workspace.`;

  // 4. Agent-Antwort speichern und über alle Kanäle senden
  messageService.saveDirectMessage(
    task.originConversationId,
    'agent',
    agentResponse,
    task.originPlatform,
  );

  // 5. Outbound: Antwort an Telegram/WhatsApp/etc. senden
  await deliverOutbound(task.originPlatform, task.originExternalChatId, agentResponse);
}
```

**Aufwand:** ~0.5 Tage

---

### ⑤ Task-Persistence (SQLite)

```sql
-- src/server/worker/workerRepository.ts

CREATE TABLE IF NOT EXISTS worker_tasks (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  objective            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'queued',
  -- 'queued' | 'planning' | 'clarifying' | 'executing' |
  -- 'review' | 'completed' | 'failed' | 'cancelled'
  priority             TEXT NOT NULL DEFAULT 'normal',
  origin_platform      TEXT NOT NULL, -- 'Telegram', 'WebChat', etc.
  origin_conversation  TEXT NOT NULL, -- conversation_id für Rückmeldung
  origin_external_chat TEXT,          -- externe Chat-ID (Telegram chat_id)
  current_step_index   INTEGER DEFAULT 0,
  result_summary       TEXT,
  error_message        TEXT,
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  completed_at         TEXT
);

CREATE TABLE IF NOT EXISTS worker_steps (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES worker_tasks(id),
  step_index   INTEGER NOT NULL,
  description  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  output       TEXT,
  tool_calls   TEXT, -- JSON: welche Tools aufgerufen wurden
  started_at   TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS worker_artifacts (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES worker_tasks(id),
  name      TEXT NOT NULL,
  type      TEXT NOT NULL, -- 'code' | 'file' | 'doc' | 'image' | 'data'
  content   TEXT NOT NULL,
  mime_type TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL REFERENCES worker_tasks(id),
  timestamp TEXT NOT NULL,
  level     TEXT NOT NULL, -- 'info' | 'warn' | 'error' | 'tool' | 'think'
  message   TEXT NOT NULL
);
```

**Aufwand:** ~0.5 Tage

---

## 5. Auswirkung auf bestehenden Code

### Was sich ÄNDERT:

```
DATEI                                  ÄNDERUNG
─────────────────────────────────────  ──────────────────────────────────
services/gateway.ts                    System-Instruction erweitern
  → SYSTEM_INSTRUCTION                 (Orchestrator-Rolle + delegate_task)

src/modules/app-shell/useAgentRuntime  Neuer Tool-Handler: delegate_task
  → handleAgentResponse()              (neben core_memory, core_task)

WorkerView.tsx                         Von "eigener Agent" zu "Dashboard"
  → startNewTask(), analyzeTask()      Liest Tasks aus Server-API statt
  → executeTaskPlan()                  eigene AI-Calls zu machen

src/server/channels/messages/service   Neuer Event für task_completed
  → handleInbound()                    (optional: auch handleWebUI erweitern)
```

### Was NEU entsteht:

```
NEUE DATEIEN                           BESCHREIBUNG
─────────────────────────────────────  ──────────────────────────────────
src/server/worker/                     Neues Server-Modul
  ├── workerAgent.ts                   Hauptlogik: Plan → Execute → Report
  ├── workerPlanner.ts                 Task-Analyse und Plan-Erstellung
  ├── workerExecutor.ts                ReAct-Loop pro Schritt
  ├── workerRepository.ts             SQLite-Persistence für Tasks
  └── workerCallback.ts               Rückmeldung an Super-Intelligenz

core/worker/                           Neues Core-Modul (Client-Seite)
  └── index.ts                         delegate_task Tool-Definition + Handler

app/api/worker/                        Neue API-Routes
  ├── route.ts                         GET/POST Worker-Tasks
  ├── [id]/route.ts                    GET/PATCH einzelner Task
  └── [id]/logs/route.ts               GET Task-Logs (für UI)
```

### Was GLEICH bleibt:

```
✅ Multi-Provider Model Hub           → Wird vom Worker genutzt
✅ Skill-System                        → Worker nutzt Skills server-seitig
✅ Memory-System                       → Super-Intelligenz nutzt es weiter
✅ Messaging/SSE                       → Worker sendet Updates via SSE
✅ Frontend-Views                      → WorkerView wird zum reinen Dashboard
✅ Telegram/WhatsApp Integration       → Unverändert, callback sendet dorthin
```

---

## 6. Beispiel-Szenarien (End-to-End)

### Szenario 1: Einfache Frage (Direkt-Antwort)

```
User (Telegram): "Wie wird das Wetter morgen?"

🧠 Super-Intelligenz denkt:
   → Das ist eine Frage → Direkt-Antwort
   → core_memory_recall: Hat der User einen Standort gespeichert?
   → search_web: Wetter für [Standort] morgen

Chat antwortet (Telegram):
   "Morgen wird es in Berlin sonnig, 12°C. Perfektes Wetter
    für einen Spaziergang! ☀️"

   core_memory_store: "User interessiert sich für Wetter"
```

### Szenario 2: Komplexe Aufgabe (Worker-Delegation)

```
User (Telegram): "Erstelle mir eine WebSeite für Notizen mit React"

🧠 Super-Intelligenz denkt:
   → Das ist eine Aufgabe → delegate_task
   → Mehrere Schritte nötig (Setup, Code, Styling, ...)
   → Keine sofortige Antwort möglich

Chat antwortet (Telegram):
   "Ich erstelle dir eine Notiz-WebSeite mit React.
    Ich richte einen Workspace ein und arbeite daran.
    Du bekommst Bescheid wenn es fertig ist. 📝"

⚙️ Worker startet (im Hintergrund, server-seitig):

   [PLANNING]
   → Analyse: React-App mit Notiz-CRUD
   → Plan:
     1. Projekt-Setup (Vite + React + TypeScript)
     2. Datenmodell definieren (Note interface)
     3. Komponenten bauen (NoteList, NoteEditor, NoteCard)
     4. LocalStorage-Persistence
     5. Styling (Dark Mode)
     6. Test & Review

   [EXECUTING Step 1/6]
   → shell_execute: "npx -y create-vite@latest notes-app --template react-ts"
   → Observe: ✅ Projekt erstellt

   [EXECUTING Step 2/6]
   → file_write: src/types.ts → Note interface
   → Observe: ✅ Typen definiert

   ... (Steps 3-5) ...

   [EXECUTING Step 6/6]
   → shell_execute: "npm run build"
   → Observe: ✅ Build erfolgreich, keine Fehler

   [REVIEW]
   → Zusammenfassung erstellen
   → 3 Artefakte: App-Code, Screenshot, README

Worker → Super-Intelligenz:
   "Task fertig. React-App für Notizen erstellt mit CRUD,
    Dark Mode, LocalStorage. Build erfolgreich."

🧠 Super-Intelligenz → User (Telegram):
   "✅ Deine Notiz-WebSeite ist fertig!

   Ich habe eine React-App mit TypeScript gebaut:
   • Notizen erstellen, bearbeiten, löschen
   • Dark Mode Design
   • LocalStorage Speicherung
   • Build läuft fehlerfrei

   Details und Code findest du im Workspace. 🚀"
```

### Szenario 3: Aufgabe mit Rückfrage

```
User (WebChat): "Analysiere das Projekt und schreib Tests"

🧠 Super-Intelligenz: → delegate_task

Chat antwortet:
   "Ich starte eine Test-Analyse für das Projekt.
    Der Worker schaut sich den Code an und schreibt Tests."

⚙️ Worker:
   [PLANNING]
   → Aufgabe unklar: Welches Projekt? Welche Tests (Unit, E2E)?
   → Status: 'clarifying'

Worker → Super-Intelligenz:
   "Rückfrage: Welches Projekt soll analysiert werden?
    Und sollen Unit-Tests oder E2E-Tests geschrieben werden?"

🧠 Super-Intelligenz → User:
   "Der Worker hat eine Rückfrage:
    • Welches Projekt meinst du?
    • Sollen Unit-Tests oder E2E-Tests entstehen?"

User: "Das aktuelle OpenClaw-Projekt, Unit-Tests bitte"

🧠 Super-Intelligenz → Worker:
   → Antwort weiterleiten

⚙️ Worker setzt fort...
```

---

## 7. Implementierungs-Plan (Reihenfolge)

```
PHASE  BAUSTEIN                          DATEIEN                    AUFWAND
─────  ────────────────────────────────  ─────────────────────────  ──────
  1    ⑤ Task-Persistence (SQLite)       server/worker/repo.ts      0.5 Tag
       → Basis für alles andere          api/worker/route.ts

  2    ② delegate_task Tool              core/worker/index.ts       0.5 Tag
       → Chat-Agent kann delegieren      useAgentRuntime.ts

  3    ① System-Instruction erweitern    services/gateway.ts        1 Std
       → Orchestrator-Rolle definieren

  4    ③ Server-seitiger Worker-Agent    server/worker/agent.ts     2-3 Tage
       → Kern: Plan → Execute → Report  server/worker/planner.ts
                                         server/worker/executor.ts

  5    ④ Task-Completion Callback        server/worker/callback.ts  0.5 Tag
       → Worker → Super-Int. → User     messages/service.ts

  6    WorkerView.tsx refactoren         WorkerView.tsx             1 Tag
       → Von Agent zu Dashboard          api/worker/[id]/route.ts
       → Liest aus Server-API

─────────────────────────────────────────────────────────────────────────
                                                    GESAMT: ~5-6 Tage
```

### Was NICHT in Phase 1 ist (kommt später):

| Feature                          | Warum später                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| **Intelligentes Model-Routing**  | Erstmal funktioniert Fallback-Pipeline. Optimierung kommt nach der Basis.                   |
| **ReAct-Loop im Chat**           | Chat braucht das NICHT. Der Chat bleibt einfach & schnell. Nur der Worker braucht den Loop. |
| **Proaktiver Background-Dienst** | Baut auf dem Worker auf. Kann als "periodischer Self-Task" implementiert werden.            |
| **Auth & Permissions**           | Wichtig, aber orthogonal. Kann parallel entwickelt werden.                                  |
| **Interest-Engine**              | Kann als Memory-Erweiterung schrittweise eingebaut werden.                                  |

---

## 8. Architektur-Entscheidungen

### E1: Warum Chat und Worker GETRENNT bleiben

| Eigenschaft        | Chat (Super-Intelligenz)                | Worker                             |
| ------------------ | --------------------------------------- | ---------------------------------- |
| **Latenz**         | < 3 Sekunden (sofort)                   | Minuten bis Stunden                |
| **Kontext**        | Chat-History (50 Nachrichten)           | Einzelner Task + Objective         |
| **Tools**          | Memory, Schedule, Search, delegate_task | Shell, File, Python, Browser, ALLE |
| **Ausführung**     | Client-seitig (Browser)                 | **Server-seitig** (Node.js)        |
| **Lebensdauer**    | Solange Chat offen                      | Überlebt Browser-Schließen         |
| **Fehlertoleranz** | Retry bei Fehler                        | Selbstkorrektur + Retry            |
| **Modell**         | Schnelles Modell (Flash)                | Starkes Modell (Pro/GPT-4)         |

### E2: Warum der Worker SERVER-seitig laufen muss

```
❌ Aktuell: Worker im Frontend (WorkerView.tsx)
   → User schließt Tab → Worker stoppt
   → User auf Telegram → kein Worker-Zugriff
   → Frontend kann keinen Shell-Befehl ausführen
   → Kein echtes File-System

✅ Neu: Worker auf dem Server (src/server/worker/)
   → Läuft unabhängig vom Browser
   → Telegram-Nachricht kann Worker starten
   → Server hat echten Shell/FS-Zugriff
   → Task überlebt Server-Restart (via SQLite)
   → Status-Updates via SSE an Frontend
```

### E3: Warum EIN delegate_task Tool statt vieler

```
❌ Alternative: Viele spezialisierte Tools
   → create_website, analyze_code, write_tests, ...
   → Problem: Jedes neue Task-Typ braucht ein neues Tool
   → LLM muss aus immer mehr Tools wählen

✅ Gewählt: EIN generisches delegate_task Tool
   → Flexibel: Jede Aufgabe beschreibbar
   → LLM muss nur entscheiden: Frage oder Aufgabe?
   → Worker analysiert selbst was zu tun ist
   → Erweiterbar ohne Chat-Agent-Änderungen
```

---

## 9. Zusammenfassung

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  AKTUELL:                                                    │
│  • Chat = dumme Antwortmaschine                              │
│  • Worker = Frontend-only, manuell, isoliert                 │
│  • Keine Verbindung Chat ↔ Worker                           │
│  • Telegram kann keinen Worker starten                       │
│                                                              │
│  NEU:                                                        │
│  • Chat = Super-Intelligenz (Orchestrator)                   │
│  • Worker = Server-seitiger autonomer Agent                  │
│  • Chat delegiert Aufgaben an Worker                         │
│  • Worker meldet Ergebnisse zurück an Chat                   │
│  • Telegram, WebChat, WhatsApp → alles kann Worker nutzen    │
│  • Tasks überleben Browser-Schließen/Server-Restart          │
│                                                              │
│  AUFWAND: ~5-6 Arbeitstage für die Basis-Implementation      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Bereit zum Implementieren — Phase 1 (Task-Persistence) kann sofort starten.**
