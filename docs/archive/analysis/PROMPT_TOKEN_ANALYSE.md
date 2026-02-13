# Prompt-Aufbau & Token-Risiko Analyse

> **Datum:** 2026-02-11  
> **Scope:** Server-seitiger Chat-Dispatch (`MessageService.dispatchToAI()`)

---

## 1. Prompt-Aufbau — Wie wird der Request an das Model gebaut?

### Flow: Vom User-Input zum AI-Request

```
User tippt Nachricht
  → POST /api/channels/messages
    → MessageService.handleInbound()
      → User-Nachricht in SQLite speichern
      → routeMessage() → target: 'chat'
      → dispatchToAI()
        → ContextBuilder.buildGatewayMessages(convId, userId, 50)
          → Conversation Summary vorhanden?
            JA  → System-Msg: "Conversation summary: ..."
            NEIN → Nur rohe History
          → + letzte unsummarized Messages (max 50, mapped roles)
        → messages[] → ModelHubService.dispatchWithFallback()
          → Provider-Adapter (Gemini / OpenAI / Anthropic / etc.)
```

### Beteiligte Dateien

| Datei                                                    | Rolle                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/server/channels/messages/contextBuilder.ts`         | Baut das `messages[]`-Array für den Gateway                                           |
| `src/server/channels/messages/service.ts`                | `dispatchToAI()` — orchestriert den gesamten AI-Dispatch                              |
| `src/server/model-hub/service.ts`                        | `dispatchWithFallback()` — iteriert Pipeline-Models mit Fallback                      |
| `src/server/model-hub/gateway.ts`                        | Routing zum Provider-Adapter                                                          |
| `src/server/model-hub/Models/gemini/index.ts`            | Gemini-Adapter: extrahiert System-Messages → `systemInstruction`                      |
| `src/server/model-hub/Models/shared/openaiCompatible.ts` | OpenAI-kompatibler Adapter: `max_tokens: 4096`, `temperature: 0.7`                    |
| `services/gateway.ts`                                    | **Client-seitig** — enthält `SYSTEM_INSTRUCTION`, wird NICHT im Server-Pfad verwendet |

---

## 2. Was genau wird an das Model gesendet?

Der Prompt besteht aus **maximal 2 Teilen**, gebaut in `contextBuilder.ts`:

| #   | Bestandteil                         | Inhalt                                                             | Begrenzung                                                   |
| --- | ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| 1   | **Conversation Summary** (optional) | `{ role: "system", content: "Conversation summary: ..." }`         | Max 5.000 Zeichen (`.slice(-5000)`)                          |
| 2   | **Message History**                 | Letzte unsummarized Nachrichten, role-mapped (`agent`→`assistant`) | Max **50 Messages**, **keine Zeichenbegrenzung pro Message** |

### ContextBuilder Code (Kernlogik)

```typescript
buildGatewayMessages(conversationId: string, userId: string, limit = 50): GatewayMessage[] {
  const context = this.repo.getConversationContext(conversationId, userId);
  const history = this.repo.listMessages(conversationId, limit, undefined, userId);
  const unsummarizedHistory = context
    ? history.filter((msg) => typeof msg.seq !== 'number' || msg.seq > context.summaryUptoSeq)
    : history;

  const mapped = unsummarizedHistory.map((msg) => ({
    role: msg.role === 'agent' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
    content: msg.content,
  }));

  if (context?.summaryText?.trim()) {
    return [
      { role: 'system', content: `Conversation summary: ${context.summaryText.trim()}` },
      ...mapped,
    ];
  }
  return mapped;
}
```

### Kritisch: Kein System-Prompt im Server-Pfad

Die `SYSTEM_INSTRUCTION` in `services/gateway.ts` (der deutsche "Proactive Agent" Prompt) wird **nur client-seitig** bei `ai.chats.create()` verwendet. `dispatchToAI()` sendet **keinen** System-Prompt — das Model bekommt nur rohe Conversation History.

---

## 3. Wird Memory injiziert?

**Nein.** Das Memory-System (`core/memory/`) ist rein client-seitig:

- `core_memory_store`, `core_memory_recall` sind Gemini Tool-Deklarationen in `core/memory/gemini.ts`
- `handleCoreMemoryCall()` und `getMemorySnapshot()` nutzen `fetch('/api/memory')` — Browser-seitige Calls
- Der `ContextBuilder` auf dem Server hat **keinen Zugriff** auf den VectorStore
- Bei Server-seitigem Dispatch werden **keine Memory-Nodes, keine Embeddings, keine Tools** mitgesendet

---

## 4. Token-Überfüllungs-Risiko

### Risikoübersicht

| Risikofaktor                     | Bewertung   | Detail                                                                                                         |
| -------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| **Kein Token-Counting**          | 🔴 **HOCH** | Nirgends im Code wird gezählt, wie viele Tokens die Messages haben                                             |
| **Keine Context-Window-Prüfung** | 🔴 **HOCH** | `context_window` wird in Model-Metadaten gespeichert, aber **nie gegen die tatsächliche Prompt-Größe geprüft** |
| **50 Messages ohne Längenlimit** | 🔴 **HOCH** | Jede einzelne Message kann beliebig lang sein                                                                  |
| **Summary unbegrenzt wachsend**  | 🟡 MITTEL   | Summary wird auf 5.000 Zeichen gecapped (~1.250 Tokens), das ist OK                                            |
| **Output-Token-Default**         | 🟢 NIEDRIG  | `max_tokens: 4096` als Output-Default bei OpenAI/Anthropic                                                     |

### Worst-Case-Szenarien

#### Normal-Szenario (kein Problem):

```
50 Messages × ∅ 200 Zeichen  =  10.000 Zeichen ≈  2.500 Tokens  ✅ OK
+ Summary:                                       ≈  1.250 Tokens
───────────────────────────────────────────────────────────────────
Gesamt Input:                                     ≈  3.750 Tokens
```

#### Mittleres Szenario:

```
50 Messages × ∅ 2.000 Zeichen = 100.000 Zeichen ≈ 25.000 Tokens  ⚠️
+ Summary:                                       ≈  1.250 Tokens
───────────────────────────────────────────────────────────────────
Gesamt Input:                                     ≈ 26.250 Tokens
```

#### Worst-Case (Code-Einfügungen, Dokumente):

```
50 Messages × ∅ 10.000 Zeichen = 500.000 Zeichen ≈ 125.000 Tokens  ❌ OVERFLOW
+ Summary:                                        ≈   1.250 Tokens
────────────────────────────────────────────────────────────────────
Gesamt Input:                                      ≈ 126.250 Tokens
```

Das überschreitet die Context-Windows vieler Modelle:

- GPT-4 (original): 8K Tokens ❌
- GPT-4-32k: 32K Tokens ❌
- GPT-4o: 128K Tokens ❌ (bei Worst-Case)
- Claude 3.5: 200K Tokens ✅
- Gemini 1.5 Pro: 1M Tokens ✅

### Fehlendes Token-Management im Code

```typescript
// dispatchToAI() — KEINE Prüfung vor dem Senden:
private async dispatchToAI(conversation, platform, externalChatId) {
  const messages = this.contextBuilder.buildGatewayMessages(conversation.id, conversation.userId, 50);
  // ↑ Hier passiert NICHTS zur Token-Prüfung
  // messages wird direkt an den Provider gesendet
  const result = await service.dispatchWithFallback('p1', encryptionKey, { messages });
}
```

---

## 5. Zusammenfassung der Probleme

| #   | Problem                                                                                                | Schwere        |
| --- | ------------------------------------------------------------------------------------------------------ | -------------- |
| 1   | **Kein System-Prompt im Chat-Pfad** — Das Model bekommt keine Persona/Instruktionen, antwortet "nackt" | 🔴 Kritisch    |
| 2   | **Kein Token-Counting** — Es gibt keinen Mechanismus, der die Prompt-Größe vor dem Senden prüft        | 🔴 Kritisch    |
| 3   | **Kein Context-Window-Check** — `context_window` aus den Model-Metadaten wird nie genutzt              | 🔴 Kritisch    |
| 4   | **Memory wird ignoriert** — Server-seitig existiert kein Memory-Zugriff                                | 🟡 Feature-Gap |
| 5   | **Keine Truncation-Strategie** — Bei zu vielen/langen Messages gibt es keinen Fallback                 | 🔴 Kritisch    |

---

## 6. Empfohlene Fixes

| Prio   | Fix                                          | Aufwand | Beschreibung                                                                                   |
| ------ | -------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| **P0** | System-Prompt in `dispatchToAI()` injizieren | Klein   | `SYSTEM_INSTRUCTION` oder konfigurierbaren System-Prompt als erste System-Message einfügen     |
| **P0** | Token-Counting vor Dispatch                  | Mittel  | Token-Zähler (z.B. `tiktoken` oder Zeichenbasiert ~4 chars/token) einbauen                     |
| **P0** | Context-Window-Check                         | Mittel  | Gegen `context_window` des gewählten Models prüfen, History dynamisch kürzen                   |
| **P1** | Truncation-Strategie                         | Mittel  | Bei Überschreitung: älteste Messages entfernen, mittlere zusammenfassen, oder Summary triggern |
| **P1** | Memory-Kontext serverseitig einbauen         | Mittel  | `ContextBuilder` um Memory-Abfrage erweitern, relevante Nodes als Context injizieren           |
| **P2** | Max-Zeichenlimit pro Message                 | Klein   | Einzelne Messages auf z.B. 10.000 Zeichen truncaten mit Hinweis                                |
| **P2** | Token-Usage-Monitoring                       | Klein   | `usage` aus GatewayResponse loggen und als Metrik tracken                                      |

---

## 7. Architektur-Diagramm: Ist-Zustand vs. Soll-Zustand

### Ist-Zustand (problematisch):

```
User Message → DB speichern → 50 Messages laden → DIREKT an Provider senden
                                                    ↑ Kein System-Prompt
                                                    ↑ Kein Token-Check
                                                    ↑ Kein Memory
```

### Soll-Zustand (empfohlen):

```
User Message → DB speichern → 50 Messages laden
  → System-Prompt prependen
  → Memory-Kontext injizieren
  → Token-Count berechnen
  → Gegen Context-Window prüfen
  → Bei Überschreitung: trim/summarize
  → An Provider senden
```
