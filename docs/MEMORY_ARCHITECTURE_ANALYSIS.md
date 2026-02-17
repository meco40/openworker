# Memory-Architektur Analyse: OpenClaw Gateway

**Datum:** 2026-02-16 (IST-Stand, korrigiert)  
**Ziel:** Optimierung für 24-Stunden-Begleiter mit totalem Recall

---

## Executive Summary

Die Architektur ist **weiter fortgeschritten** als ursprünglich analysiert. Chat-FTS5, Knowledge-Recall und Tool-Calling (Frontend) laufen bereits.

**Das echte Problem:** Tool-Calling läuft nur im **Frontend** (`useAgentRuntime.ts`), aber nicht im **Server-Chat** (`dispatchToAI` in `service.ts`). Telegram/WhatsApp/WebChat-Nutzer haben keine Tool-Unterstützung.

**Empfohlener nächster Schritt:** Tool-Calling für Server-Chat aktivieren.

---

## 1. IST-Architektur (Korrigiert)

### 1.1 Recall-Pipeline (buildRecallContext)

**Pfad:** `src/server/channels/messages/service.ts:1244-1360`

```typescript
// Parallel + Fusion (nicht sequentiell!)
async buildRecallContext(...) {
  const [knowledgeResult, memoryResult, chatResult] = await Promise.allSettled([
    this.tryKnowledgeRecall(...),     // ✅ Knowledge Layer
    this.tryMemoryRecall(...),        // ✅ mem0
    this.tryChatRecall(...)           // ✅ Chat-FTS5 (searchMessages)
  ]);

  // Fusion aller drei Quellen
  return this.fuseRecallSources({
    knowledge: knowledgeResult,
    memory: memoryResult,
    chat: chatResult  // [Chat History] wird eingebunden
  });
}
```

**Was läuft:**

- ✅ Knowledge (Ledger + Episodes) + mem0 + Chat-FTS5 **parallel**
- ✅ Token-Budget Management (1200 chars)
- ✅ Feedback-Tracking (`lastRecallByConversation`)

### 1.2 Tool-Calling Status

| Pfad                                          | Status     | Tools verfügbar?                                     |
| --------------------------------------------- | ---------- | ---------------------------------------------------- |
| **Frontend** (`useAgentRuntime.ts:70,82,140`) | ✅ Aktiv   | `CORE_MEMORY_TOOLS` werden übergeben und verarbeitet |
| **Server-Chat** (`dispatchToAI`)              | ❌ Inaktiv | Keine Tools, nur Push-Recall                         |

**Konsequenz:**

- App-Shell-Agent: KI kann selbst `core_memory_recall` aufrufen
- Telegram/WhatsApp/WebChat: System entscheidet (Push), KI hat keine Kontrolle

### 1.3 Auto-Memory Extraktion

**Pfad:** `src/server/channels/messages/autoMemory.ts`

```typescript
// Erkennt:
- "ich mag / ich liebe" → preference
- "ich mag nicht / ich hasse / vermeide" → avoidance
- "Termin / Meeting / morgen" → fact

// Problem:
"Lass nicht nach Aldi gehen"
→ Enthält KEIN Avoidance-Keyword
→ Wird als 'fact' klassifiziert ❌
```

---

## 2. Probleme (Korrigiert)

### Problem 1: Tool-Calling nur im Frontend

```
User (Telegram): "Was war mit Andreas?"
  ↓
Server: buildRecallContext() → System entscheidet
  ↓
KI bekommt: "Hier sind 3 Memories" (ob sie will oder nicht)

VS

User (App-Shell): "Was war mit Andreas?"
  ↓
Frontend: KI entscheidet "Ich sollte suchen"
  ↓
KI ruft: core_memory_recall(query: "Andreas")
  ↓
KI bekommt: Exakt was sie angefordert hat
```

**Impact:** Server-Chat-Nutzer haben schlechtere Memory-Interaktion.

### Problem 2: Negation nicht generisch erkannt

```typescript
// autoMemory.ts erkennt nur:
/(ich mag nicht|ich hasse|vermeide)/i → avoidance

// Aber NICHT:
"Lass nicht nach Aldi gehen" → fact (falsch!)
"Ich will keinen Kaffee" → fact (falsch!)
```

---

## 3. Lösungen (Korrigiert)

### Lösung 1: Tool-Calling im Server aktivieren

**Ziel:** Auch Telegram/WhatsApp/WebChat bekommen Tool-Unterstützung.

```typescript
// src/server/channels/messages/service.ts:dispatchToAI

async dispatchToAI(...) {
  // IST: Push-Recall
  const memoryContext = await this.buildRecallContext(...);
  messages.unshift({ role: 'system', content: memoryContext });

  // NEU: Biete Tools an (wie im Frontend)
  const response = await service.dispatchWithFunctionCalling(
    'p1',
    encryptionKey,
    {
      messages,
      tools: CORE_MEMORY_TOOLS  // Aus core/memory/gemini.ts
    }
  );

  if (response.functionCalls?.length > 0) {
    // Führe Tool-Calls aus
    const results = await Promise.all(
      response.functionCalls.map(c => this.executeTool(c))
    );
    // Zweiter Call mit Results
  }
}
```

**Voraussetzung:** `dispatchWithFunctionCalling` im ModelHub muss implementiert werden.

**Alternativ (Quick Fix):**

- Heuristik-Router (lokal, kostenlos) entscheidet: Memory-Frage Ja/Nein
- Nur bei "Ja" wird `buildRecallContext` aufgerufen
- 80% der Anfragen sparen sich den Recall-Overhead

### Lösung 2: Negation generisch erkennen

```typescript
// autoMemory.ts erweitern
const NEGATION_WORDS = [
  'nicht',
  'kein',
  'keine',
  'nie',
  'niemals',
  'lass uns nicht',
  'wollen wir nicht',
];

function classifyCandidate(content) {
  const hasNegation = NEGATION_WORDS.some((n) => lower.includes(n));

  if (hasNegation) {
    return { type: 'avoidance', importance: 4 }; // Statt fact
  }
  // ... restliche Logik
}
```

---

## 4. Roadmap (Korrigiert)

| Priorität | Task                              | Status              | Aufwand      |
| --------- | --------------------------------- | ------------------- | ------------ |
| **P0**    | Tool-Calling im Server aktivieren | ❌ Fehlt            | 1-2 Tage     |
| **P1**    | Negations-Erkennung fixen         | ❌ Fehlt            | 30 Min       |
| ~~P2~~    | ~~Chat-FTS5 integrieren~~         | ✅ **Bereits drin** | ~~Entfällt~~ |

---

## 5. Fazit

### Was läuft (nicht ändern):

- ✅ Chat-FTS5 ist bereits im Recall-Pfad (`recallFromChat`)
- ✅ Knowledge + Memory + Chat werden parallel gefused
- ✅ Tool-Calling läuft im Frontend
- ✅ Token-Budget Management existiert

### Was fehlt:

- 🔧 Tool-Calling im **Server-Chat** (größter Hebel)
- 🔧 Generische **Negations-Erkennung**

### Was ist überflüssig:

- ❌ Neue Vektor-DB (mem0 läuft)
- ❌ Chat-FTS5 Integration (bereits drin)

**Entscheidung:** Tool-Calling im Server aktivieren ODER Heuristik-Router als Zwischenlösung.

---

**Autor:** Kimi Code CLI  
**Version:** 3.1 (Korrigiert nach Code-Review)  
**Status:** Bereit für Implementation
