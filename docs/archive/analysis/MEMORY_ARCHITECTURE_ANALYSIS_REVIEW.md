# Analyse: MEMORY_ARCHITECTURE_ANALYSIS.md

**Prüfdatum:** 2026-02-16  
**Prüfer:** Code Review

---

## Zusammenfassung der Prüfungsergebnisse

| Behauptung im Dokument                                  | Status | Bewertung                                     |
| ------------------------------------------------------- | ------ | --------------------------------------------- |
| Chat-FTS5, Knowledge-Recall laufen bereits              | ✅     | **Korrekt**                                   |
| Tool-Calling nur im Frontend aktiv                      | ✅     | **Korrekt**                                   |
| Server-Chat (dispatchToAI) hat keine Tools              | ✅     | **Korrekt**                                   |
| Negation nicht generisch erkannt                        | ✅     | **Korrekt**                                   |
| "dispatchWithFunctionCalling" muss implementiert werden | ❌     | **Falsch** - Infrastructure existiert bereits |
| Chat-FTS5 muss integriert werden                        | ❌     | **Falsch** - Bereits implementiert            |

---

## Detailanalyse

### 1. ✅ Recall-Pipeline (buildRecallContext)

**Behauptung:** `buildRecallContext` führt Knowledge, Memory und Chat parallel aus.

**Prüfung:**

- [`recallFromKnowledge()`](src/server/channels/messages/service.ts:1296) ✅
- [`recallFromMemory()`](src/server/channels/messages/service.ts:1321) ✅
- [`recallFromChat()`](src/server/channels/messages/service.ts:1352) ✅

**Code-Beweis (Zeile 1273-1277):**

```typescript
const [knowledgeResult, memoryResult, chatResult] = await Promise.allSettled([
  this.recallFromKnowledge(knowledgeRetrievalService, memoryUserIds, conversation, userInput),
  this.recallFromMemory(memoryUserIds, conversation, userInput),
  this.recallFromChat(conversation, userInput),
]);
```

**Fazit:** Die Behauptung ist **korrekt**. Die drei Recall-Quellen werden parallel via `Promise.allSettled` ausgeführt.

---

### 2. ✅ Tool-Calling nur im Frontend

**Behauptung:** Tool-Calling läuft nur in `useAgentRuntime.ts`, nicht in `dispatchToAI`.

**Prüfung Frontend ([`useAgentRuntime.ts:70`](src/modules/app-shell/useAgentRuntime.ts:70)):**

```typescript
const allTools = [...CORE_MEMORY_TOOLS, ...optionalTools];
```

**Prüfung Server ([`service.ts:956-966`](src/server/channels/messages/service.ts:956)):**

```typescript
const result = await service.dispatchWithFallback(
  'p1',
  encryptionKey,
  {
    messages,
    auditContext: { kind: 'chat', conversationId: conversation.id },
    // KEINE tools hier!
  },
  { signal: abortController.signal, modelOverride },
);
```

**Fazit:** Die Behauptung ist **korrekt**. Der Server dispatcht ohne `tools`-Parameter.

---

### 3. ⚠️ "dispatchWithFunctionCalling muss implementiert werden" - **TEILWEISE FALSCH**

**Behauptung:** `dispatchWithFunctionCalling` im ModelHub muss implementiert werden.

**Prüfung der Infrastructure:**

[`Models/types.ts:58`](src/server/model-hub/Models/types.ts:58):

```typescript
export interface GatewayRequest {
  model: string;
  messages: GatewayMessage[];
  // ...
  tools?: unknown[]; // ← BEREITS VORHANDEN!
  // ...
}
```

[`Models/types.ts:73`](src/server/model-hub/Models/types.ts:73):

```typescript
export interface GatewayResponse {
  // ...
  functionCalls?: Array<{ name: string; args?: unknown }>; // ← BEREITS VORHANDEN!
}
```

**Fazit:** Die Infrastructure für Tool-Calling ist **bereits vorhanden**!

- `GatewayRequest` hat bereits `tools?: unknown[]`
- `GatewayResponse` hat bereits `functionCalls`

**Was fehlt:** Nur der **Aufruf** in `dispatchToAI` muss angepasst werden, um Tools zu übergeben. Eine neue `dispatchWithFunctionCalling`-Funktion ist **nicht erforderlich** - es genügt, das existierende `dispatchWithFallback` mit einem `tools`-Feld zu nutzen.

---

### 4. ✅ Negation nicht generisch erkannt

**Behauptung:** Auto-Memory erkennt Negation nicht generisch - "Lass nicht nach Aldi gehen" wird als 'fact' klassifiziert.

**Prüfung ([`autoMemory.ts:61-63`](src/server/channels/messages/autoMemory.ts:61)):**

```typescript
if (/\b(ich mag nicht|ich hasse|vermeide|i dislike|i hate|avoid)\b/i.test(lower)) {
  return { type: 'avoidance', content: clipText(text), importance: 4 };
}
```

**Analyse:**

- "ich mag nicht" → ✅ Erkannt
- "ich hasse" → ✅ Erkannt
- "vermeide" → ✅ Erkannt
- "Lass nicht nach Aldi gehen" → ❌ **NICHT erkannt** (kein Keyword)
- "Ich will keinen Kaffee" → ❌ **NICHT erkannt** (kein Keyword)

**Fazit:** Die Behauptung ist **korrekt**. Es fehlt eine generische Negationserkennung.

---

### 5. ❌ "Chat-FTS5 muss integriert werden" - **FALSCH**

**Behauptung:** Chat-FTS5 muss integriert werden.

**Prüfung ([`service.ts:1352`](src/server/channels/messages/service.ts:1352)):**

```typescript
private recallFromChat(
  conversation: Conversation,
  userInput: string,
): Promise<string> {
  // ... full-text search implementation
}
```

**Fazit:** Chat-FTS5 ist **bereits implementiert** als `recallFromChat()`.

---

## Korrigierte Empfehlungen

### Was tatsächlich getan werden muss:

| Priorität | Task                             | Aufwand | Begründung                                          |
| --------- | -------------------------------- | ------- | --------------------------------------------------- |
| **P0**    | Tools in dispatchToAI aktivieren | 30 Min  | Gateway unterstützt bereits tools, nur Aufruf fehlt |
| **P1**    | Negations-Erkennung fixen        | 30 Min  | autoMemory.ts muss erweitert werden                 |

### Was NICHT getan werden muss:

| Task                                           | Begründung                                              |
| ---------------------------------------------- | ------------------------------------------------------- |
| ~~dispatchWithFunctionCalling implementieren~~ | Nicht nötig - `dispatchWithFallback` mit `tools` nutzen |
| ~~Chat-FTS5 integrieren~~                      | Bereits vorhanden als `recallFromChat`                  |

---

## Technische Lösung für P0

Um Tool-Calling im Server zu aktivieren, genügt folgende Änderung in [`service.ts:956`](src/server/channels/messages/service.ts:956):

```typescript
// Importiere CORE_MEMORY_TOOLS
import { CORE_MEMORY_TOOLS } from '../../../core/memory';

// In dispatchToAI:
const result = await service.dispatchWithFallback(
  'p1',
  encryptionKey,
  {
    messages,
    tools: CORE_MEMORY_TOOLS, // ← DIESES FELD HINZUFÜGEN
    auditContext: { kind: 'chat', conversationId: conversation.id },
  },
  { signal: abortController.signal, modelOverride },
);
```

---

## Fazit

Das Dokument ist in seinen **Kernaussagen korrekt**:

- ✅ Tool-Calling nur im Frontend
- ✅ Negation nicht generisch erkannt
- ✅ Recall-Pipeline parallel

**Aber es enthält zwei Fehler:**

1. ❌ Behauptet, `dispatchWithFunctionCalling` müsse implementiert werden - die Infrastructure existiert bereits
2. ❌ Behauptet, Chat-FTS5 müsse integriert werden - es ist bereits vorhanden

**Empfehlung:** Das Dokument sollte entsprechend korrigiert werden, bevor es als Grundlage für Implementation-Entscheidungen genutzt wird.
