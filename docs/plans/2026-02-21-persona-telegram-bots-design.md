# Design: Persona-gebundene Telegram Bots

**Datum:** 2026-02-21  
**Status:** Genehmigt zur Implementierung  
**Entscheidungen:**

- UI-Einstiegspunkt: Persona-Settings (ein Bot-Token-Feld pro Persona)
- Kein globaler Fallback-Bot mehr (altes Single-Bot-System bleibt im Code aber wird nicht gestartet)

---

## Problem

Der aktuelle Telegram-Channel ist ein **globaler Single-Bot**. Alle Personas teilen sich einen Telegram-Chat-Thread. Der Nutzer kann nicht gleichzeitig mit "Girl" in einem separaten Telegram-Chat und "Nexus" in einem anderen schreiben.

---

## Lösung: Persona Telegram Bot Registry

Jede Persona kann **optional** einen eigenen Telegram-Bot bekommen. Jeder Bot hat ein eigenes BotFather-Token, seinen eigenen Webhook oder Polling-Loop und liefert Nachrichten direkt an die gebundene Persona.

```
User ──► @girl_bot (BotToken A) ──► Persona: Girl
User ──► @nexus_bot (BotToken B) ──► Persona: Nexus
```

---

## Architektur

### Datenhaltung

Neue Tabelle `persona_telegram_bots` in `personas.db`:

```sql
CREATE TABLE IF NOT EXISTS persona_telegram_bots (
  bot_id        TEXT PRIMARY KEY,         -- slug/UUID z.B. "girl" oder gen. ID
  persona_id    TEXT NOT NULL UNIQUE,     -- FK zu personas.id (1:1)
  token         TEXT NOT NULL,            -- BotFather API-Token
  webhook_secret TEXT NOT NULL,           -- generiert beim Pairing
  peer_name     TEXT,                     -- Bot @username aus getMe
  transport     TEXT NOT NULL DEFAULT 'polling', -- 'webhook' | 'polling'
  polling_offset INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

**Einschränkungen:**

- `UNIQUE(persona_id)` — eine Persona hat max. einen Telegram-Bot (kann später gelockert werden)
- Token wird in Plaintext gespeichert (wie der bisherige `credential_store`)

### Neue Dateien

| Datei                                                           | Zweck                                               |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `src/server/telegram/personaTelegramBotRegistry.ts`             | Service + SQLite-Repository für Bot-Konfigurationen |
| `src/server/telegram/personaTelegramPoller.ts`                  | Multi-Poller: `Map<botId, TimerHandle>`             |
| `src/server/telegram/personaTelegramPairing.ts`                 | Pair/Unpair-Logik pro Persona                       |
| `app/api/personas/[personaId]/telegram/route.ts`                | REST-API: GET/POST/DELETE                           |
| `app/api/channels/telegram/bots/[botId]/webhook/route.ts`       | Per-Bot Webhook-Endpoint                            |
| `src/modules/personas/components/PersonaTelegramBotSection.tsx` | UI-Komponente in Persona-Settings                   |

### Geänderte Dateien

| Datei                                            | Änderung                                                      |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `src/server/channels/outbound/telegram.ts`       | `deliverTelegram(chatId, text, options?)` mit `options.token` |
| `src/server/channels/outbound/router.ts`         | Weitergabe von `options.token` an `deliverTelegram`           |
| `src/server/channels/messages/service.ts`        | `sendResponse` übergibt Token wenn Persona einen Bot hat      |
| `src/server/channels/pairing/telegramInbound.ts` | Optionaler `BotContext` Parameter                             |
| `server.ts`                                      | Persona-Bots beim Start aktivieren                            |

---

## Datenfluss

### Inbound (Webhook/Polling)

```
POST /api/channels/telegram/bots/[botId]/webhook
  → verify webhook_secret for botId
  → getPersonaTelegramBotRegistry().getBot(botId)
  → processTelegramPersonaBotUpdate(update, { botId, personaId, token })
    → skip code-pairing (alle Chats sind authorized für diesen Bot)
    → MessageService.handleInbound({ personaId, ... })
```

### Outbound

```
MessageService.sendResponse(conversation, content, platform, externalChatId)
  → if platform === TELEGRAM && conversation.personaId:
      registry.getBotByPersonaId(personaId) → bot.token
  → deliverOutbound(platform, externalChatId, content, { token })
  → deliverTelegram(chatId, text, { token })
    → when token provided: use it directly
    → fallback: global credential store (backward compat)
```

### Server-Start

```
server.ts startup
  → getPersonaTelegramBotRegistry().listActiveBots()
  → for each bot with transport='polling': startPersonaBot(bot)
```

---

## API-Endpunkte

### `GET /api/personas/[personaId]/telegram`

Gibt Bot-Status zurück (kein Token im Response).

```json
{
  "ok": true,
  "bot": {
    "botId": "girl",
    "personaId": "persona-abc",
    "peerName": "girl_assistant_bot",
    "transport": "webhook",
    "active": true,
    "createdAt": "2026-02-21T..."
  }
}
```

### `POST /api/personas/[personaId]/telegram`

Pairing starten.

Request: `{ "token": "1234567890:AAF..." }`

Response: `{ "ok": true, "peerName": "girl_assistant_bot", "transport": "webhook" }`

### `DELETE /api/personas/[personaId]/telegram`

Bot entfernen, Webhook löschen, Polling stoppen.

---

## UI in Persona-Settings

In der Persona-Edit-Ansicht (`PersonasView` / `PersonaDetailsPanel`) wird eine neue Sektion ergänzt:

```
┌─────────────────────────────────────────┐
│ ✈️  Telegram Bot                         │
│                                          │
│  Status: ● Verbunden (@girl_bot)         │
│  Transport: Webhook                      │
│                                          │
│  [Trennen]                               │
└─────────────────────────────────────────┘

--- oder wenn kein Bot ---

┌─────────────────────────────────────────┐
│ ✈️  Telegram Bot                         │
│                                          │
│  Verbinde einen eigenen Telegram-Bot     │
│  mit dieser Persona. Erstelle einen Bot  │
│  via @BotFather und gib den Token ein.   │
│                                          │
│  [Bot-Token eingeben...]  [Verbinden]    │
└─────────────────────────────────────────┘
```

---

## Backward Compatibility

- Der alte `telegram`-Credential-Store-Eintrag bleibt unberührt
- Das alte Polling (`telegramPolling.ts`) und Pairing (`telegramCodePairing.ts`) bleiben im Code
- Beim Server-Start wird **nur noch `personaTelegramPoller.ts`** aktiv gestartet (der alte globale Poller nicht mehr automatisch)
- Nutzer die den alten Bot konfiguriert hatten, müssen ihn neu als Persona-Bot einrichten

---

## Test-Strategie

1. **Unit:** `PersonaTelegramBotRegistry` mit `:memory:` SQLite
2. **Unit:** `personaTelegramPairing` — Mock `fetch`, prüfe Token-Validierung + Webhook-Setup
3. **Unit:** `personaTelegramPoller` — Mock `fetch`, prüfe Multi-Poller-State-Machine
4. **Integration:** Webhook-Route mit echtem Bot-Kontext
