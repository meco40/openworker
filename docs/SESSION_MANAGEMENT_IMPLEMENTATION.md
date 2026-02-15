# Session Management — Implementierungsbericht

**Datum:** 2026-02-12  
**Bezug:** docs/archive/analysis/OPENCLAW_FUNKTIONSANALYSE.md → Feature #3 (Session Management System)  
**Priorität:** ⭐⭐⭐⭐⭐ Kritisch  
**Status:** Vollständig implementiert, auditiert & validiert (349/349 Tests, Build OK)

---

## 1. Ausgangslage

### Das Problem

Die docs/archive/analysis/OPENCLAW_FUNKTIONSANALYSE.md bewertete das Session Management unserer WebApp mit **⚠️ Basic** (3/10) — im Vergleich zum OpenClaw-Referenzsystem mit **✅ Fortgeschritten** (9/10). Session Management war als **MUST HAVE #3** eingestuft:

| Aspekt                     | OpenClaw (Referenz)     | WebApp (vorher)         |
| -------------------------- | ----------------------- | ----------------------- |
| Session-Persistenz         | ✅ JSONL-Logs, Recovery | ✅ SQLite (vorhanden)   |
| Chat-Abbruch               | ✅ AbortSignal-Chain    | ❌ Nicht möglich        |
| Session löschen            | ✅ CLI + API            | ❌ Keine Löschfunktion  |
| Session zurücksetzen       | ✅ `/new` Command       | ❌ Kein Reset           |
| Duplikat-Erkennung         | ✅ Idempotency          | ❌ Keine Deduplizierung |
| Model Override pro Session | ✅ Session-Patch        | ❌ Nur globales Model   |

### Was fehlte

Die WebApp konnte:

- **Keine laufende KI-Generierung abbrechen** — einmal gesendet, lief die Anfrage bis zum Ende (oder Timeout)
- **Keine Konversation löschen** — Nutzer konnten ungewollte Chats nie entfernen
- **Keine Session zurücksetzen** — kein „neuer Chat" ohne manuelles Erstellen
- **Doppelte Nachrichten nicht verhindern** — Netzwerk-Retries oder Doppelklick führten zu Duplikaten
- **Kein Model pro Session wechseln** — alle Sessions nutzten dasselbe globale Modell

---

## 2. Was wurde implementiert

### F1: Chat Abort (AbortSignal-Kette)

**Problem:** Wenn der Nutzer nach dem Absenden einer Nachricht die Antwort nicht mehr brauchte (z.B. falscher Kontext, zu lange Wartezeit), gab es keinen Weg, die laufende KI-Anfrage abzubrechen. Der Server schickte die Anfrage weiter ans Model, wartete auf die Antwort, verarbeitete sie — alles umsonst.

**Lösung:** End-to-End AbortSignal-Kette vom Browser bis zum Provider-Adapter:

```
Browser (Stop-Button)
  → WS: chat.abort { conversationId }
    → MessageService.abortGeneration()
      → AbortController.abort()
        → AbortSignal propagiert durch:
          → dispatchWithFallback() — bricht Fallback-Pipeline ab
            → dispatchGatewayRequest() — bricht Provider-Call ab
              → Provider-Adapter (OpenAI/Anthropic/Gemini/xAI/ByteDance)
                → HTTP-Request wird abgebrochen (fetch signal)
```

**Geänderte Dateien:**

| Datei                                                    | Änderung                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/server/channels/messages/service.ts`                | `activeRequests` Map, `dispatchToAI()` mit AbortController, `abortGeneration()` Methode |
| `src/server/model-hub/service.ts`                        | `dispatchWithFallback()` prüft `signal.aborted` vor jedem Versuch                       |
| `src/server/model-hub/gateway.ts`                        | Forwarded `{ signal }` an Provider-Adapter                                              |
| `src/server/model-hub/Models/types.ts`                   | `dispatchGateway()` Interface erweitert um `options?: { signal?: AbortSignal }`         |
| `src/server/model-hub/Models/shared/http.ts`             | `fetchWithTimeout()` kombiniert Timeout + externes Signal via `AbortSignal.any()`       |
| `src/server/model-hub/Models/shared/openaiCompatible.ts` | `dispatchOpenAICompatibleChat()` akzeptiert `signal` Option                             |
| `src/server/model-hub/Models/openai/index.ts`            | Forwarded `options.signal` an `dispatchOpenAICompatibleChat()`                          |
| `src/server/model-hub/Models/xai/index.ts`               | Forwarded `options.signal` an `dispatchOpenAICompatibleChat()`                          |
| `src/server/model-hub/Models/bytedance/index.ts`         | Forwarded `options.signal` an `dispatchOpenAICompatibleChat()`                          |
| `src/server/model-hub/Models/anthropic/index.ts`         | Forwarded `options.signal` an `fetchWithTimeout()`                                      |
| `src/server/model-hub/Models/gemini/index.ts`            | `Promise.race()` mit AbortSignal (Google SDK unterstützt kein natives Signal)           |
| `src/server/gateway/methods/chat.ts`                     | `chat.abort` RPC-Methode + Broadcast                                                    |
| `src/server/gateway/events.ts`                           | `CHAT_ABORTED` Event-Typ + Payload                                                      |
| `src/modules/chat/components/ChatInputArea.tsx`          | Stop-Button bei laufender Generierung                                                   |
| `src/modules/chat/hooks/useChatInterfaceState.ts`        | `isGenerating` State + `handleAbort` Callback                                           |
| `components/ChatInterface.tsx`                           | Drähtet `isGenerating`/`handleAbort` zur ChatInputArea                                  |
| `src/modules/app-shell/useConversationSync.ts`           | Listener für `chat.aborted` Event                                                       |

**Verbesserung:**

- Sofortiger Abbruch statt Warten auf Timeout (bis zu 60s Ersparnis)
- Ressourcen werden freigegeben (HTTP-Verbindungen, Token-Verbrauch)
- UX: Visuelles Feedback durch Stop-Button

---

### F2: Session Delete

**Problem:** Konversationen konnten nur erstellt, nie gelöscht werden. Testchats, sensible Inhalte oder verwaiste Sessions blieben permanent in der Datenbank.

**Lösung:** Löschfunktion über WebSocket-RPC und REST-API:

```
sessions.delete { conversationId }
  → MessageService.deleteConversation()
    → Repository: DELETE messages + DELETE conversations
      → Broadcast: conversation.deleted
        → Frontend entfernt Konversation aus Liste
```

**Geänderte Dateien:**

| Datei                                                     | Änderung                                                  |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `src/server/channels/messages/repository.ts`              | `deleteConversation()` Interface                          |
| `src/server/channels/messages/sqliteMessageRepository.ts` | SQL: `DELETE FROM messages` + `DELETE FROM conversations` |
| `src/server/channels/messages/service.ts`                 | `deleteConversation(conversationId, userId)`              |
| `src/server/gateway/methods/sessions.ts`                  | `sessions.delete` RPC-Methode                             |
| `src/server/gateway/events.ts`                            | `CONVERSATION_DELETED` Event                              |
| `app/api/channels/conversations/route.ts`                 | `DELETE /api/channels/conversations` Handler              |
| `src/modules/app-shell/useConversationSync.ts`            | Listener für `conversation.deleted`                       |

**Verbesserung:**

- Nutzer können ungewollte Chats entfernen
- Datenschutz: Sensible Konversationen löschbar
- Saubere Datenbank ohne verwaiste Einträge

---

### F3: Session Reset (`/new` Command)

**Problem:** Kein Mechanismus für einen „frischen Start". Der Nutzer musste zum Chat-Bildschirm navigieren und manuell eine neue Konversation erstellen.

**Lösung:** `/new` und `/reset` als Session-Commands + RPC-Methode:

```
Nutzer tippt "/new" oder "/reset"
  → MessageRouter erkennt SESSION_COMMANDS
    → RouteResult.target = 'session-command'
      → MessageService erstellt neue Konversation
        → Broadcast: conversation.reset { oldConversationId, newConversationId }
          → Frontend wechselt zur neuen Konversation

Alternativ über WebSocket:
sessions.reset { title? }
  → Gleicher Fluss
```

**Geänderte Dateien:**

| Datei                                           | Änderung                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `src/server/channels/messages/messageRouter.ts` | `SESSION_COMMANDS = ['/new', '/reset']`, neues `session-command` Target |
| `src/server/channels/messages/service.ts`       | Session-Command-Branch in `handleInbound()`                             |
| `src/server/gateway/methods/sessions.ts`        | `sessions.reset` RPC-Methode                                            |
| `src/server/gateway/events.ts`                  | `CONVERSATION_RESET` Event                                              |
| `src/modules/app-shell/useConversationSync.ts`  | Listener für `conversation.reset`                                       |

**Verbesserung:**

- Schneller Kontextwechsel ohne UI-Navigation
- Konsistent mit dem OpenClaw `/new` Pattern
- Funktioniert über Chat-Input UND WebSocket-RPC

---

### F4: Idempotency / Duplikat-Erkennung

**Problem:** Bei Netzwerk-Problemen oder Doppelklick konnte dieselbe Nachricht mehrfach gespeichert und an die KI gesendet werden. Duplikate verschwendeten Tokens und verwirrten den Konversationsverlauf.

**Lösung:** Client-generierte `clientMessageId` (UUID) mit Unique-Index in der Datenbank:

```
Browser generiert: crypto.randomUUID()
  → Schickt mit jeder Nachricht: { content, clientMessageId }
    → Server prüft:
      1. processingMessages.has(clientMessageId)? → Skip (in-flight)
      2. findMessageByClientId(clientMessageId)? → Return existing (already saved)
      3. Sonst: Normal verarbeiten
    → SQLite: UNIQUE INDEX auf (conversation_id, client_message_id)
```

**Geänderte Dateien:**

| Datei                                                     | Änderung                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `App.tsx`                                                 | `sendChatMessage` generiert `crypto.randomUUID()`                                 |
| `src/server/channels/messages/repository.ts`              | `SaveMessageInput.clientMessageId`, `findMessageByClientId()`                     |
| `src/server/channels/messages/sqliteMessageRepository.ts` | `client_message_id TEXT` Spalte + Unique-Index, Duplikat-Check in `saveMessage()` |
| `src/server/channels/messages/service.ts`                 | `processingMessages` Set für In-Flight-Dedup, Guard in `handleInbound()`          |
| `src/server/channels/messages/historyManager.ts`          | `appendUserMessage` forwarded `clientMessageId`                                   |
| `src/server/gateway/methods/chat.ts`                      | `chat.send`/`chat.stream` akzeptieren `clientMessageId`                           |
| `app/api/channels/messages/route.ts`                      | POST akzeptiert `clientMessageId`                                                 |

**Verbesserung:**

- Keine doppelten Nachrichten mehr bei Retry/Doppelklick
- Zweischichtiger Schutz: In-Memory (Set) + Datenbank (Unique Index)
- Idempotent: Wiederholte Requests liefern dasselbe Ergebnis

---

### F5: Per-Session Model Override

**Problem:** Alle Konversationen nutzten dasselbe globale KI-Modell. Wenn der Nutzer für eine bestimmte Aufgabe ein anderes Modell testen wollte (z.B. GPT-4 für Code, Claude für Texte), musste die globale Einstellung geändert werden — was alle anderen offenen Chats beeinflusste.

**Lösung:** `modelOverride` Feld pro Konversation mit Bypass der Fallback-Pipeline:

```
sessions.patch { conversationId, modelOverride: "gpt-4o" }
  → Repository: UPDATE conversations SET model_override = ?
    → Bei nächster Nachricht:
      → dispatchWithFallback() erkennt modelOverride
        → Bypass: Direkt zum spezifizierten Model (kein Fallback-Chain)
        → Oder: modelOverride = null → zurück zur globalen Pipeline

REST:
PATCH /api/channels/conversations { conversationId, modelOverride }
```

**Geänderte Dateien:**

| Datei                                                     | Änderung                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `types.ts`                                                | `Conversation.modelOverride: string \| null`                                         |
| `src/server/channels/messages/repository.ts`              | `updateModelOverride()` Interface                                                    |
| `src/server/channels/messages/sqliteMessageRepository.ts` | `model_override TEXT` Spalte, `updateModelOverride()`, `toConversation()` mappt Feld |
| `src/server/channels/messages/service.ts`                 | `setModelOverride()`, forwarded `modelOverride` an `dispatchWithFallback()`          |
| `src/server/model-hub/service.ts`                         | `modelOverride` Parameter in `dispatchWithFallback()` — Bypass-Logik                 |
| `src/server/gateway/methods/sessions.ts`                  | `sessions.patch` RPC-Methode                                                         |
| `app/api/channels/conversations/route.ts`                 | `PATCH` Handler                                                                      |

**Verbesserung:**

- Model-Wechsel pro Chat ohne globale Seiteneffekte
- Bypass der Fallback-Pipeline für deterministische Model-Nutzung
- Rücksetzbar: `modelOverride = null` → zurück zum Standard

---

## 3. Provider-Adapter Signal-Fix (Audit-Fund)

### Entdeckung

Bei der systematischen 45-Punkt-Verifizierung aller 5 Features wurde eine Lücke gefunden: Alle 5 Provider-Adapter (OpenAI, xAI, ByteDance, Anthropic, Gemini) ignorierten den `options`-Parameter mit dem AbortSignal. Die Signal-Kette brach auf der letzten Meile — direkt vor dem HTTP-Request an den KI-Provider.

### Zustand vorher

```typescript
// Alle 5 Adapter hatten diese Signatur:
dispatchGateway({ secret }, request) {
  // options-Parameter fehlte → Signal wurde stillschweigend ignoriert
}
```

### Fix

| Provider      | Strategie                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI**    | `options.signal` → `dispatchOpenAICompatibleChat({ signal })` → `fetch({ signal })`                                                                   |
| **xAI**       | Identisch zu OpenAI (OpenAI-kompatible API)                                                                                                           |
| **ByteDance** | Identisch zu OpenAI (OpenAI-kompatible API)                                                                                                           |
| **Anthropic** | `options.signal` → `fetchWithTimeout(url, body, 60_000, signal)` → `AbortSignal.any([timeout, signal])`                                               |
| **Gemini**    | Pre-Abort-Check + `Promise.race()` zwischen `ai.models.generateContent()` und Signal-Listener (Google GenAI SDK unterstützt kein natives AbortSignal) |

### Gemini-Sonderlösung

Das `@google/genai` SDK bietet keine Möglichkeit, ein `AbortSignal` an `generateContent()` zu übergeben. Die Lösung:

```typescript
async dispatchGateway({ secret }, request, options) {
  // Pre-check: Wenn bereits abgebrochen, sofort werfen
  if (options?.signal?.aborted) {
    throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
  }

  // Race zwischen SDK-Call und Signal
  const result = await (options?.signal
    ? Promise.race([
        ai.models.generateContent({ ... }),
        new Promise((_, reject) => {
          options.signal!.addEventListener('abort', () => {
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          }, { once: true });
        }),
      ])
    : ai.models.generateContent({ ... })
  );
}
```

---

## 4. Audit-Ergebnis

### 45 Checkpoints, 5 Features

| Feature            | Checkpoints | Ergebnis          |
| ------------------ | ----------- | ----------------- |
| F1: Chat Abort     | 13          | ✅ 13/13 PASS     |
| F2: Session Delete | 7           | ✅ 7/7 PASS       |
| F3: Session Reset  | 8           | ✅ 8/8 PASS       |
| F4: Idempotency    | 8           | ✅ 8/8 PASS       |
| F5: Model Override | 9           | ✅ 9/9 PASS       |
| **Gesamt**         | **45**      | **✅ 45/45 PASS** |

### Automatisierte Validierung

```
npx vitest run   → 349/349 Tests bestanden (73 Dateien)
npm run build    → Erfolgreich (0 Fehler)
```

---

## 5. Vergleich: Vorher vs. Nachher

| Dimension          | Vorher (3/10)        | Nachher (8/10)                   | Delta |
| ------------------ | -------------------- | -------------------------------- | ----- |
| **Chat Abort**     | ❌ Unmöglich         | ✅ End-to-End Signal, 5 Provider | +++   |
| **Session Delete** | ❌ Keine Löschung    | ✅ WS + REST, Broadcast          | +++   |
| **Session Reset**  | ❌ Manuell           | ✅ `/new` Command + RPC          | ++    |
| **Idempotency**    | ❌ Duplikate möglich | ✅ UUID + DB-Unique-Index        | +++   |
| **Model Override** | ❌ Nur global        | ✅ Pro Session, Pipeline-Bypass  | ++    |
| **Provider Abort** | ❌ Signal-Drop       | ✅ Alle 5 Provider unterstützt   | +++   |

### Warum 8/10 und nicht 10/10?

Die verbleibenden 2 Punkte betreffen OpenClaw-Features, die noch nicht implementiert sind:

- **Session-Tools für Agents** (`sessions_list`, `sessions_send`, `sessions_history`) — Agent-zu-Agent-Kommunikation
- **Queue Modes / Activation Modes** — Erweiterte Session-Orchestrierung

Diese sind in der docs/archive/analysis/OPENCLAW_FUNKTIONEN_ANALYSE_WEBAPP.md als Phase 2 geplant.

---

## 6. Architektur-Muster

### AbortSignal-Threading (Node 20+)

```
AbortController (MessageService)
  └─ signal
     └─ AbortSignal.any([timeoutSignal, userAbortSignal])  ← fetchWithTimeout
        └─ fetch({ signal })  ← HTTP-Verbindung wird abgebrochen
```

Verwendet `AbortSignal.any()` (Node 20+) um mehrere Abbruchgründe zu kombinieren: User-Abort UND Timeout werden in einem einzigen Signal vereint.

### Zweischichtige Duplikat-Erkennung

```
Schicht 1: In-Memory Set (processingMessages)
  → Fängt Duplikate während aktiver Verarbeitung ab
  → Kein DB-Roundtrip nötig

Schicht 2: SQLite Unique Index (conversation_id + client_message_id)
  → Fängt Duplikate nach Neustart oder bei Race Conditions ab
  → Datenbank-Garantie
```

### Model-Override Pipeline-Bypass

```
Normaler Fluss:        Model A → fail → Model B → fail → Model C
Model Override (GPT-4): GPT-4 → fail → Error (kein Fallback)
```

Der Override umgeht bewusst die Fallback-Kette, damit der Nutzer deterministisch das gewählte Modell bekommt.

---

## 7. Dateiübersicht

### Neue Dateien

| Datei                                    | Zweck                                                     |
| ---------------------------------------- | --------------------------------------------------------- |
| `src/server/gateway/methods/sessions.ts` | `sessions.delete`, `sessions.reset`, `sessions.patch` RPC |

### Geänderte Dateien (Kern)

| Datei                                                     | Änderungen                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                                                | `Conversation.modelOverride` Feld                                                                                      |
| `src/server/gateway/events.ts`                            | 3 neue Events (CHAT_ABORTED, CONVERSATION_DELETED, CONVERSATION_RESET)                                                 |
| `src/server/gateway/index.ts`                             | Import `./methods/sessions`                                                                                            |
| `src/server/gateway/methods/chat.ts`                      | `chat.abort` Methode, `clientMessageId` bei send/stream                                                                |
| `src/server/channels/messages/service.ts`                 | `activeRequests`, `processingMessages`, `abortGeneration()`, `deleteConversation()`, `setModelOverride()`, Dedup-Guard |
| `src/server/channels/messages/repository.ts`              | 3 neue Methoden, `SaveMessageInput.clientMessageId`                                                                    |
| `src/server/channels/messages/sqliteMessageRepository.ts` | Migration (2 Spalten + Index), 3 neue Methoden, Dedup in `saveMessage()`                                               |
| `src/server/channels/messages/messageRouter.ts`           | Session-Commands                                                                                                       |
| `src/server/channels/messages/historyManager.ts`          | `clientMessageId` Forwarding                                                                                           |
| `src/server/model-hub/service.ts`                         | `signal` + `modelOverride` in `dispatchWithFallback()`                                                                 |
| `src/server/model-hub/gateway.ts`                         | Signal-Forwarding an Adapter                                                                                           |
| `src/server/model-hub/Models/types.ts`                    | `options` Parameter im Interface                                                                                       |
| `src/server/model-hub/Models/shared/http.ts`              | `externalSignal` + `AbortSignal.any()`                                                                                 |
| `src/server/model-hub/Models/shared/openaiCompatible.ts`  | `signal` Option                                                                                                        |

### Geänderte Dateien (Provider-Adapter)

| Datei                                            | Änderung                                 |
| ------------------------------------------------ | ---------------------------------------- |
| `src/server/model-hub/Models/openai/index.ts`    | `options` → `{ signal }` forwarding      |
| `src/server/model-hub/Models/xai/index.ts`       | `options` → `{ signal }` forwarding      |
| `src/server/model-hub/Models/bytedance/index.ts` | `options` → `{ signal }` forwarding      |
| `src/server/model-hub/Models/anthropic/index.ts` | `options.signal` → `fetchWithTimeout`    |
| `src/server/model-hub/Models/gemini/index.ts`    | `options` → Pre-check + `Promise.race()` |

### Geänderte Dateien (Frontend)

| Datei                                             | Änderung                                 |
| ------------------------------------------------- | ---------------------------------------- |
| `App.tsx`                                         | `crypto.randomUUID()` für Idempotency    |
| `src/modules/chat/components/ChatInputArea.tsx`   | Stop-Button                              |
| `src/modules/chat/hooks/useChatInterfaceState.ts` | `isGenerating` + `handleAbort`           |
| `components/ChatInterface.tsx`                    | Prop-Wiring                              |
| `src/modules/app-shell/useConversationSync.ts`    | Event-Listener (deleted, reset, aborted) |

### REST-Endpunkte

| Route                         | Methode  | Zweck                  |
| ----------------------------- | -------- | ---------------------- |
| `/api/channels/conversations` | `DELETE` | Konversation löschen   |
| `/api/channels/conversations` | `PATCH`  | Model-Override setzen  |
| `/api/channels/messages`      | `POST`   | `clientMessageId` Feld |

### WebSocket-RPC-Methoden

| Methode           | Parameter                            | Beschreibung                       |
| ----------------- | ------------------------------------ | ---------------------------------- |
| `chat.abort`      | `{ conversationId }`                 | Laufende Generierung abbrechen     |
| `sessions.delete` | `{ conversationId }`                 | Konversation + Nachrichten löschen |
| `sessions.reset`  | `{ title? }`                         | Neue Konversation erstellen        |
| `sessions.patch`  | `{ conversationId, modelOverride? }` | Session-Eigenschaften ändern       |

---

**Abgeschlossen:** 2026-02-12  
**Verifiziert:** 45/45 Checkpoints, 349/349 Tests, Build erfolgreich  
**Nächste Schritte:** Agent-zu-Agent Sessions (Phase 2 lt. docs/archive/analysis/OPENCLAW_FUNKTIONEN_ANALYSE_WEBAPP.md)

---

## Single-Principal Session Policy (Current)

- Session-Management bleibt `user_id`-scoped.
- Aktuell keine Login-Aktivierung im Rahmen der Single-Principal-Konsolidierung.
- Bei optionaler Auth wird ein Principal-Fallback genutzt; bei verpflichtender Auth bleibt 401-Verhalten erhalten.
- Geplante Login-Aktivierung ist ausgelagert in:
  `docs/plans/2026-02-15-single-principal-login-activation-deferred.md`.
