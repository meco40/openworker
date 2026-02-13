# 🔍 Messenger Routing — Vollständige Architektur-Analyse & Review

> **Datum:** 2026-02-10  
> **Review-Iteration:** 2 (aktualisiert nach Implementierung von Security & Credential Store)  
> **Gesamtbewertung:** **8.5 / 10** — Solide, gut strukturierte Implementierung mit wenigen verbleibenden Verbesserungspotenzialen

---

## Architektur-Übersicht

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (messenger/)                                          │
│  ChannelPairing.tsx → TelegramHandler / WhatsAppHandler         │
│  GenericChannelHandler (wiederverwendbar für Discord / iMessage) │
├─────────────────────────────────────────────────────────────────┤
│  API Routes (app/api/channels/)                                 │
│  POST/DELETE /pair        → Pairing + Unpair                    │
│  GET/POST   /messages     → Message CRUD                        │
│  GET        /stream       → SSE Real-Time Push                  │
│  GET/POST   /conversations→ Conversation Management             │
│  POST       /{platform}/webhook → Inbound Webhooks              │
├─────────────────────────────────────────────────────────────────┤
│  Server Layer (src/server/channels/)                            │
│  messages/service.ts       → Zentrale Business-Logik            │
│  messages/repository.ts    → Repository Interface               │
│  messages/sqliteRepo.ts    → SQLite-Implementierung             │
│  messages/runtime.ts       → Singleton-Bootstrapping            │
│  outbound/router.ts        → Platform-spezifisches Routing      │
│  outbound/{platform}.ts    → Delivery-Funktionen                │
│  pairing/index.ts          → Channel-Kopplung                   │
│  pairing/unpair.ts         → Channel-Entkopplung (NEU)          │
│  credentials/              → Persistenter Credential Store (NEU)│
│  webhookAuth.ts            → Webhook-Signaturverifizierung (NEU)│
│  sse/manager.ts            → Real-Time Push                     │
├─────────────────────────────────────────────────────────────────┤
│  Persistence (SQLite mit Repository Pattern)                    │
│  messages.db: conversations + messages Tabellen                 │
│  messages.db: channel_credentials Tabelle (NEU)                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✅ Was nach Best Practice implementiert ist

### 1. Layered Architecture (Schichtenarchitektur) — ⭐ Exzellent (9/10)

Die Architektur folgt einem sauberen **4-Schichten-Modell**:

- **Frontend** → UI-Komponenten mit Channel-spezifischer UX
- **API Routes** → Thin Controller Layer (Next.js App Router)
- **Server Layer** → Business-Logik, Routing, Credential Management
- **Persistence** → Repository Pattern mit SQLite

**Positiv:**

- Jede Schicht hat klar definierte Verantwortlichkeiten
- API-Routes delegieren sofort an Service-Layer (kein Business-Code in Routes)
- `export const runtime = 'nodejs'` korrekt auf allen API-Routes gesetzt

### 2. Repository Pattern — ⭐ Exzellent (9/10)

- `MessageRepository` Interface mit `SqliteMessageRepository` Implementierung
- Saubere Trennung von Persistenz-Logik und Business-Logik
- Einfach austauschbar (z.B. gegen MySQL/PostgreSQL)
- **Alle Queries parameterisiert → SQL-Injection-sicher**
- In-Memory-Modus für Tests (`:memory:`)
- Indexe auf `conversations(channel_type, external_chat_id)` und `messages(conversation_id, created_at)`

### 3. Unified Inbound Pipeline — ⭐ Exzellent (9/10)

`MessageService.handleInbound()` ist der **Single Entry Point** für alle Kanäle:

```
Webhook POST → handleInbound()
    1. getOrCreateConversation()     ← Auto-Konversationsverwaltung
    2. repo.saveMessage(user)        ← Persistenz
    3. SSE broadcast(userMsg)        ← Real-Time Push ans Frontend
    4. Build conversation history    ← Context für AI (letzte 50 Messages)
    5. ModelHub dispatchWithFallback()← AI-Antwort generieren
    6. repo.saveMessage(agent)       ← Antwort persistieren
    7. SSE broadcast(agentMsg)       ← Real-Time Push
    8. deliverOutbound()             ← Antwort zurück an Plattform
```

**Das ist genau der richtige Ansatz** — ein einziger, konsistenter Flow für alle Plattformen. Kein Plattform-spezifischer Sondercode in der Pipeline.

### 4. Webhook Security — ⭐ Sehr gut (8/10) 🆕

Die Webhook-Security wurde seit dem letzten Review **vollständig implementiert**:

| Plattform | Verifizierungsmethode              | Implementiert in          |
| --------- | ---------------------------------- | ------------------------- |
| Telegram  | `X-Telegram-Bot-Api-Secret-Token`  | `verifyTelegramWebhook()` |
| Discord   | Ed25519 Signatur-Verifizierung     | `verifyDiscordWebhook()`  |
| WhatsApp  | Shared Secret (`X-Webhook-Secret`) | `verifySharedSecret()`    |
| iMessage  | Shared Secret (`X-Webhook-Secret`) | `verifySharedSecret()`    |

**Details:**

- `webhookAuth.ts` enthält drei fokussierte Utility-Funktionen
- Alle Webhook-Routes rufen die Verifizierung **vor** dem JSON-Parsing auf
- Graceful Degradation: Wenn kein Secret konfiguriert ist (`''`), wird der Check übersprungen (sinnvoll für Entwicklung)
- Telegram-Webhook setzt bei Pairing automatisch `secret_token` via `setWebhook` API
- Discord verwendet korrekt `crypto.verify()` mit Ed25519

**Verbleibende Lücke:** Discord-Verifizierung wird nur ausgeführt wenn `DISCORD_PUBLIC_KEY` env var gesetzt ist. Ohne Key wird der Check komplett übersprungen (L22: `if (publicKey) { ... }`). Das ist inkonsistent mit Telegram, wo der Check immer aufgerufen wird.

### 5. Credential Store — ⭐ Sehr gut (8/10) 🆕

Das kritische P1-Problem der `process.env` Mutation wurde **vollständig adressiert**:

```typescript
// CredentialStore: SQLite-basierte Persistenz für Bot-Tokens
class CredentialStore {
  setCredential(channel, key, value); // UPSERT mit ON CONFLICT
  getCredential(channel, key); // Lookup
  deleteCredentials(channel); // Cleanup bei Unpair
  listCredentials(channel); // Admin-Übersicht
}
```

**Positiv:**

- Persistiert in SQLite → **überlebt Server-Restarts**
- Composite Primary Key `(channel, key)` → keine Duplikate
- UPSERT-Semantik (INSERT ON CONFLICT UPDATE)
- Singleton-Pattern analog zu SSEManager und MessageService
- Alle Outbound-Delivery-Funktionen nutzen Credential Store als **primäre Quelle** mit Fallback auf `process.env`

**Verbleibender Hinweis:** Tokens werden im Klartext in SQLite gespeichert. In einer Produktionsumgebung wäre Verschlüsselung (z.B. AES-256-GCM mit einem Master-Key) empfehlenswert, aber für den aktuellen Use Case akzeptabel.

### 6. Outbound Routing — ⭐ Sehr gut (8/10)

`outbound/router.ts` mit `deliverOutbound()` implementiert ein sauberes **Strategy-ähnliches Routing** per `switch/case`:

```typescript
switch (platform) {
  case ChannelType.TELEGRAM:
    await deliverTelegram(chatId, content);
    break;
  case ChannelType.WHATSAPP:
    await deliverWhatsApp(chatId, content);
    break;
  case ChannelType.DISCORD:
    await deliverDiscord(chatId, content);
    break;
  case ChannelType.IMESSAGE:
    await deliveriMessage(chatId, content);
    break;
  case ChannelType.WEBCHAT:
    /* SSE only, no external delivery */ break;
  default:
    console.warn(`Not implemented: ${platform}`);
}
```

**Positiv:**

- Jeder Kanal hat seine eigene `deliver*()` Funktion mit eigenem Modul
- WebChat wird korrekt übersprungen (SSE only)
- Alle Delivery-Funktionen nutzen den Credential Store primär, `process.env` als Fallback
- Fehlerhafte Delivery wird sauber gefangen und geloggt

**Delivery-Funktionen im Detail:**

| Plattform | API                                         | Auth                      | Besonderheit          |
| --------- | ------------------------------------------- | ------------------------- | --------------------- |
| Telegram  | `bot{token}/sendMessage`                    | Credential Store → env    | JSON body             |
| Discord   | `discord.com/api/v10/channels/.../messages` | `Bot {token}` Header      | Standard Bot API      |
| WhatsApp  | `{bridgeUrl}/send`                          | Implizit (Bridge-basiert) | Bridge-Architektur    |
| iMessage  | `{bridgeUrl}/send`                          | Implizit (Bridge-basiert) | `chatGuid` statt `to` |

### 7. SSE für Real-Time Push — ⭐ Sehr gut (8/10)

- Singleton-Manager mit Client-Tracking
- Automatische Bereinigung defekter Clients beim Broadcast
- Keepalive-Heartbeat (30s)
- Korrekte SSE-Header (`text/event-stream`, `X-Accel-Buffering: no`, `no-cache`)
- `dynamic = 'force-dynamic'` auf der Stream-Route (verhindert Next.js Caching)
- Initiales `connected` Event mit Client-ID

### 8. Pairing & Unpair — ⭐ Sehr gut (8/10) 🆕

Das Pairing-System wurde **um Unpair erweitert**:

**Pairing-Flow:**

| Channel  | Validierung            | Webhook-Setup                           | Token-Persistenz       |
| -------- | ---------------------- | --------------------------------------- | ---------------------- |
| Telegram | `getMe` API-Call       | `setWebhook` mit `secret_token`         | Credential Store + env |
| Discord  | `users/@me` API-Call   | _(Gateway-basiert, kein Webhook-Setup)_ | Credential Store + env |
| WhatsApp | Bridge `/health` Check | Registriert `callbackUrl` bei Bridge    | _(Bridge-managed)_     |
| iMessage | Bridge `/health` Check | Registriert `callbackUrl` bei Bridge    | _(Bridge-managed)_     |

**Unpair-Flow (NEU):**

```
DELETE /api/channels/pair → unpairChannel()
    1. Telegram: deleteWebhook API → clear credentials
    2. Discord: clear credentials (kein Webhook)
    3. WhatsApp/iMessage: DELETE bridge/webhook → clear credentials
```

**Positiv:**

- Vollständiger Lifecycle (Pair + Unpair)
- `DELETE` HTTP-Methode korrekt auf `/api/channels/pair`
- Webhook wird bei Telegram aktiv deregistriert
- Bridge-Webhook wird bei WhatsApp/iMessage deregistriert
- Frontend ruft Unpair-API auf und bereinigt lokalen State

### 9. Webhook-Handler — ⭐ Sehr gut (8/10)

- Pro Plattform eine eigene `POST` Route (`/api/channels/{platform}/webhook`)
- Platform-spezifisches Parsing (Telegram Update-Format, Discord PING, etc.)
- **Security-Check als erstes** vor Business-Logik
- Immer `200 OK` zurückgeben (verhindert Retries bei Telegram/Discord)
- Non-text Messages werden korrekt ignoriert (Sticker, Photos, etc.)
- Discord: `type === 1` PING korrekt beantwortet
- Discord: Bot-eigene Nachrichten werden gefiltert (via `author.id` Check)

### 10. Frontend Component Composition — ⭐ Gut (7/10)

- `GenericChannelHandler` als wiederverwendbare Base-Komponente (für Discord, iMessage)
- Spezifische Handler für WhatsApp (QR-Flow) und Telegram (Token-Flow)
- Tab-basierte Navigation in `ChannelPairing`
- Security Context Log im Frontend
- **Disconnect-Button ruft jetzt die Unpair-API auf** (vorher nur lokaler State)

### 11. Test-Abdeckung — ⭐ Gut (7.5/10) 🆕

Die Test-Suite wurde **signifikant erweitert**:

| Test-Datei                                    | Typ         | Was wird getestet?                    |
| --------------------------------------------- | ----------- | ------------------------------------- |
| `unit/channels/webhook-auth.test.ts`          | Unit        | Telegram & SharedSecret Verifizierung |
| `unit/channels/credential-store.test.ts`      | Unit        | CRUD, Isolation, Upsert, Delete       |
| `unit/channels/unpair.test.ts`                | Unit        | Telegram/Discord Unpair + Edge Cases  |
| `unit/channels/webhook-parsing.test.ts`       | Unit        | Alle 4 Plattformen Webhook-Parsing    |
| `unit/channels/sse-manager.test.ts`           | Unit        | Singleton, Broadcast, Error-Cleanup   |
| `unit/channels/message-repository.test.ts`    | Unit        | Conversations, Messages, Pagination   |
| `integration/channels/pairing-router.test.ts` | Integration | Pair-Route mit Fetch-Mocking          |
| `channels-pair-route.test.ts`                 | Integration | Pair-API End-to-End                   |

**Insgesamt: 8 Test-Dateien**, davon 3 neu seit letztem Review (webhook-auth, credential-store, unpair).

---

## ⚠️ Verbleibende Verbesserungspotenziale

### 🟡 P2 — Mittlere Priorität

#### 1. `process.env` Mutation als Fallback (teilweise behoben)

Der Credential Store ist die primäre Quelle, aber es gibt immer noch **doppelte Persistenz**:

```typescript
// pairing/telegram.ts L41-42
store.setCredential('telegram', 'bot_token', token);
store.setCredential('telegram', 'webhook_secret', webhookSecret);
process.env.TELEGRAM_BOT_TOKEN = token; // ← redundant
process.env.TELEGRAM_WEBHOOK_SECRET = webhookSecret; // ← redundant
```

**Warum problematisch:**

- `process.env` Mutation ist flüchtig und funktioniert nicht in Serverless
- Da der Credential Store die primäre Quelle ist und alle Consumer `getCredential() || process.env.X` nutzen, ist das env-Mutation überflüssig
- Sollte entfernt werden, um Single Source of Truth zu gewährleisten

**Empfehlung:** `process.env.*` Zuweisungen in `pairing/telegram.ts`, `pairing/discord.ts` und die `delete process.env.*` in `pairing/unpair.ts` entfernen. Die Outbound-Funktionen nutzen bereits den Credential Store primär.

#### 2. Discord Webhook-Verifizierung inkonsistent

```typescript
// discord/webhook/route.ts L21-27
const publicKey = process.env.DISCORD_PUBLIC_KEY || '';
if (publicKey) {
  // ← Check wird komplett übersprungen wenn kein Key
  const valid = await verifyDiscordWebhook(request, publicKey, body);
  if (!valid) return 403;
}
```

Im Vergleich dazu Telegram (L20-28):

```typescript
const secretToken =
  getCredentialStore().getCredential('telegram', 'webhook_secret') ||
  process.env.TELEGRAM_WEBHOOK_SECRET ||
  '';
if (!verifyTelegramWebhook(request, secretToken)) {
  return 403;
}
```

**Unterschiede:**

1. Discord nutzt **nicht** den Credential Store für den Public Key
2. Discord überspringt die Verifizierung komplett wenn kein Key vorhanden (vs. Telegram, wo `verifyTelegramWebhook` intern das Fallback handelt)

**Empfehlung:** Discord Public Key im Credential Store speichern (beim Pairing) und konsistentes Pattern verwenden.

#### 3. Dual Message Routing (App.tsx vs. MessageService)

Es existieren weiterhin **zwei parallele Routing-Pfade**:

| Pfad                                                | Wer nutzt ihn?   | AI-Dispatch                               |
| --------------------------------------------------- | ---------------- | ----------------------------------------- |
| Frontend → `routeMessage()` / `toMessage()` lokal   | WebUI Chat       | Direkt via Client SDK im Browser          |
| `MessageService.handleInbound()` → ModelHub Gateway | Externe Webhooks | Via `dispatchWithFallback()` serverseitig |

`routeMessage.ts` enthält nur noch eine `toMessage()` Helper-Funktion (Message-Objekt erstellen), was darauf hindeutet, dass der Frontend-Pfad vereinfacht wurde. Allerdings bleibt das Dual-Routing-Pattern bestehen — WebUI-Nachrichten können sowohl lokal im Frontend verarbeitet als auch via `/api/channels/messages POST` an den Server geschickt werden.

**Risiko:** Potenzielle Duplikate wenn Frontend und Backend parallel dispatchen.

#### 4. SSE ohne Conversation-/User-Filtering

`SSEManager.broadcast()` sendet **an alle verbundenen Clients**:

```typescript
broadcast(event: SSEEvent): void {
  // Sendet an ALLE Clients — kein Topic-/User-Filter
  for (const client of this.clients) { ... }
}
```

Bei mehreren verbundenen Usern oder mehreren aktiven Konversationen erhalten alle Clients alle Nachrichten. Best Practice wäre:

- `addClient(controller, { userId, conversationId })` — Client mit Kontext registrieren
- `broadcast(event, { conversationId })` — gezielt an relevante Clients senden

#### 5. Keine Retry-Logik bei Outbound-Delivery

```typescript
// service.ts L105-108
try {
  await deliverOutbound(platform, externalChatId, agentContent);
} catch (error) {
  console.error(`Outbound delivery failed for ${platform}:`, error);
  // ❌ Fire-and-forget: Nachricht geht verloren
}
```

Wenn die Outbound-Delivery fehlschlägt (z.B. Telegram API temporär down), geht die Nachricht verloren. Best Practice wäre eine Retry-Queue mit exponential Backoff.

---

### 🟢 P3 — Nice-to-have

#### 6. `ChannelType` Enum Inkonsistenz

Das Enum enthält Plattformen, die **nirgends implementiert** sind:

```typescript
export enum ChannelType {
  WHATSAPP = 'WhatsApp',
  TELEGRAM = 'Telegram',
  SLACK = 'Slack', // ← nicht implementiert
  DISCORD = 'Discord',
  WEBCHAT = 'WebChat',
  SIGNAL = 'Signal', // ← nicht implementiert
  TEAMS = 'Teams', // ← nicht implementiert (kollidiert mit View.TEAMS!)
  IMESSAGE = 'iMessage',
}
```

Zusätzlich nutzt die Pairing-Schicht eigene String-Literale (`PairChannelType = 'whatsapp' | 'telegram' | 'discord' | 'imessage'`) statt das Enum.

#### 7. Outbound Router könnte Registry Pattern verwenden

Statt `switch/case` wäre ein registrybasierter Ansatz besser erweiterbar:

```typescript
// Aktuell: switch/case mit 6 Branches
// Best Case: Registry-basiert
const handlers: Record<ChannelType, DeliveryHandler> = {
  [ChannelType.TELEGRAM]: deliverTelegram,
  [ChannelType.WHATSAPP]: deliverWhatsApp,
  // ...
};
await handlers[platform]?.(chatId, content);
```

#### 8. `GenericChannelHandler` Redundanz

`TelegramHandler` und `WhatsAppHandler` implementieren im Wesentlichen denselben UI-Flow wie `GenericChannelHandler`, nur mit visuellen Variationen (Farben, QR-Code). Diese könnten durch `GenericChannelHandler` mit erweiterten Konfigurationsobjekten ersetzt werden:

```typescript
// Statt 3 separate Komponenten:
<GenericChannelHandler
  accent="blue"
  pairingView="token"          // oder "qr-code" für WhatsApp
  pairingLabel="Validating Bot Token..."
  tokenPlaceholder="TELEGRAM_API_TOKEN"
  // ...
/>
```

#### 9. Bridge-Channels (WhatsApp/iMessage) ohne Credential Store

Während Telegram und Discord ihren Token im Credential Store speichern, nutzen WhatsApp und iMessage nur `process.env.WHATSAPP_BRIDGE_URL` / `IMESSAGE_BRIDGE_URL`. Der Bridge-URL und ein optionales Webhook-Secret könnten ebenfalls im Credential Store persistiert werden.

#### 10. Kein Rate Limiting auf Webhooks

Die Webhook-Endpoints haben zwar Signatur-Verifizierung, aber kein Rate Limiting. Ein Angreifer, der einen gültigen Secret hat, könnte die Endpoints mit Requests fluten.

---

## 📊 Best-Case Scorecard

| Kriterium                       | Status                 | Vorher | Jetzt      |
| ------------------------------- | ---------------------- | ------ | ---------- |
| Layered Architecture            | ✅ Exzellent           | 9/10   | **9/10**   |
| Repository Pattern              | ✅ Exzellent           | 9/10   | **9/10**   |
| Unified Inbound Pipeline        | ✅ Exzellent           | 8/10   | **9/10**   |
| Outbound Routing                | ✅ Sehr gut            | 7/10   | **8/10**   |
| Real-Time Push (SSE)            | ✅ Sehr gut            | 8/10   | **8/10**   |
| Webhook Handlers                | ✅ Sehr gut            | 5/10   | **8/10**   |
| Webhook Security (Auth/Signing) | ✅ Implementiert       | 2/10   | **8/10**   |
| Credential Management           | ✅ Implementiert (NEU) | —      | **8/10**   |
| Pairing / Unpair Lifecycle      | ✅ Implementiert (NEU) | 6/10   | **8/10**   |
| Frontend Integration            | ⚠️ Dual-Path-Risiko    | 6/10   | **7/10**   |
| Test Coverage                   | ✅ Gut                 | 6/10   | **7.5/10** |
| Retry/Error Recovery            | ⚠️ Fire-and-forget     | 3/10   | **3/10**   |
| **Gesamt**                      |                        | **~7** | **~8.5**   |

---

## 📈 Delta zum letzten Review

| Punkt                | Letztes Review        | Jetzt                           |
| -------------------- | --------------------- | ------------------------------- |
| 🔴 Webhook Security  | ❌ Komplett fehlend   | ✅ Für alle 4 Plattformen       |
| 🔴 Token-Persistenz  | ❌ `process.env` only | ✅ SQLite Credential Store      |
| 🔴 Disconnect/Unpair | ❌ Nur Frontend-State | ✅ DELETE API + Webhook Cleanup |
| 🟡 Test-Abdeckung    | 5 Test-Dateien        | 8 Test-Dateien (+3 neue)        |
| 🟡 Rate Limiting     | ❌ Fehlt              | ⚠️ Weiterhin offen              |
| 🟡 SSE Filtering     | ❌ Broadcast an alle  | ⚠️ Weiterhin offen              |
| 🟡 Outbound Retry    | ❌ Fire-and-forget    | ⚠️ Weiterhin offen              |

**3 von 3 P1-Problemen wurden adressiert.** Die verbleibenden Punkte sind P2/P3.

---

## 🏗️ Empfohlene nächste Schritte (priorisiert)

1. **P2**: `process.env` Mutation entfernen (Cleanup, ~15 Min)
2. **P2**: Discord Public Key im Credential Store speichern (Konsistenz)
3. **P2**: Dual-Routing konsolidieren (Frontend ↔ Backend Flow vereinheitlichen)
4. **P2**: SSE Channel-Filtering (pro Conversation/User)
5. **P2**: Outbound Retry-Queue mit Backoff
6. **P3**: Rate Limiting auf Webhook-Endpoints
7. **P3**: ChannelType Enum bereinigen (nicht implementierte Plattformen entfernen)
8. **P3**: Bridge-URLs im Credential Store speichern
9. **P3**: Frontend-Komponenten-Redundanz reduzieren

---

## Analysierte Dateien

### Frontend (4 Dateien)

- `messenger/ChannelPairing.tsx` — 175 Zeilen, Hauptkomponente
- `messenger/shared/GenericChannelHandler.tsx` — 128 Zeilen
- `messenger/telegram/TelegramHandler.tsx` — 56 Zeilen
- `messenger/whatsapp/WhatsAppHandler.tsx` — 65 Zeilen

### API Routes (8 Dateien)

- `app/api/channels/pair/route.ts` — 67 Zeilen, POST + DELETE
- `app/api/channels/messages/route.ts` — 50 Zeilen, GET + POST
- `app/api/channels/stream/route.ts` — 41 Zeilen, SSE GET
- `app/api/channels/conversations/route.ts` — 37 Zeilen, GET + POST
- `app/api/channels/telegram/webhook/route.ts` — 55 Zeilen
- `app/api/channels/whatsapp/webhook/route.ts` — 43 Zeilen
- `app/api/channels/discord/webhook/route.ts` — 60 Zeilen
- `app/api/channels/imessage/webhook/route.ts` — 44 Zeilen

### Server Layer (14 Dateien)

- `src/server/channels/messages/service.ts` — 149 Zeilen, Business-Logik
- `src/server/channels/messages/runtime.ts` — 22 Zeilen, Singleton-Bootstrap
- `src/server/channels/messages/repository.ts` — 58 Zeilen, Interface
- `src/server/channels/messages/sqliteMessageRepository.ts` — 212 Zeilen, Implementierung
- `src/server/channels/outbound/router.ts` — 35 Zeilen
- `src/server/channels/outbound/telegram.ts` — 28 Zeilen
- `src/server/channels/outbound/whatsapp.ts` — 22 Zeilen
- `src/server/channels/outbound/discord.ts` — 28 Zeilen
- `src/server/channels/outbound/imessage.ts` — 22 Zeilen
- `src/server/channels/pairing/index.ts` — 27 Zeilen
- `src/server/channels/pairing/telegram.ts` — 49 Zeilen
- `src/server/channels/pairing/discord.ts` — 22 Zeilen
- `src/server/channels/pairing/bridge.ts` — 38 Zeilen
- `src/server/channels/pairing/unpair.ts` — 71 Zeilen 🆕

### Security & Credentials (3 Dateien) 🆕

- `src/server/channels/webhookAuth.ts` — 65 Zeilen
- `src/server/channels/credentials/credentialStore.ts` — 88 Zeilen
- `src/server/channels/credentials/index.ts` — 3 Zeilen

### Types

- `types.ts` — ChannelType Enum, CoupledChannel, Conversation, Message

### Tests (8 Dateien, +3 neu)

- `tests/unit/channels/webhook-auth.test.ts` — 64 Zeilen 🆕
- `tests/unit/channels/credential-store.test.ts` — 69 Zeilen 🆕
- `tests/unit/channels/unpair.test.ts` — 64 Zeilen 🆕
- `tests/unit/channels/webhook-parsing.test.ts` — 136 Zeilen
- `tests/unit/channels/sse-manager.test.ts` — 71 Zeilen
- `tests/unit/channels/message-repository.test.ts` — 213 Zeilen
- `tests/integration/channels/pairing-router.test.ts` — Integration
- `tests/channels-pair-route.test.ts` — Integration

---

## Fazit

Die Messenger-Integration hat sich seit dem letzten Review **deutlich verbessert**. Alle drei P1-Probleme (Webhook Security, Token-Persistenz, Disconnect/Unpair) wurden adressiert. Die Architektur folgt bewährten Design-Patterns (Repository, Singleton, Layered Architecture) und ist für die vier unterstützten Plattformen (Telegram, Discord, WhatsApp, iMessage) vollständig funktionsfähig.

Die verbleibenden Punkte (SSE-Filtering, Outbound Retry, Dual-Routing-Konsolidierung) sind typische P2/P3-Items, die bei wachsender Nutzerbasis relevant werden, aber die aktuelle Funktionalität nicht einschränken. Die Gesamtbewertung steigt von **7.0 auf 8.5/10**.
