# Persona System

## Metadata

- Purpose: Verbindliche Referenz fuer Persona-Verwaltung und persona-gebundene Channel-Integrationen.
- Scope: Persona-Lifecycle, Datei-Kontext, Telegram-Bot-Bindings je Persona.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-02-22
- Related Runbooks: docs/runbooks/gateway-config-production-rollout.md

---

## 1. Funktionserlaeuterung

Das Persona-System verwaltet Identitaeten, Datei-Kontexte und persona-spezifische Channel-Bindings.

### Kernkonzepte

- **Persona**: Konfigurierbare Identitaet mit Prompting-/Kontextdaten
- **Persona Files**: Dateien pro Persona fuer dauerhaftes Kontextwissen
- **Persona Telegram Bot**: Optionaler Telegram-Bot pro Persona mit eigener Token-/Webhook-Konfiguration

Hinweis: Das fruehere Rooms-Subsystem (`/api/rooms/*`, `src/server/rooms/*`) ist aus der aktiven Runtime entfernt.

---

## 2. Architektur

### 2.1 Komponenten

- `src/server/personas/personaRepository.ts`
- `src/server/personas/`
- `src/server/channels/outbound/telegram.ts`
- `src/components/personas/PersonaEditorPane.tsx`
- `app/api/personas/*`

---

## 3. API-Referenz

### 3.1 Personas

| Methode | Pfad                                  | Zweck                           |
| ------- | ------------------------------------- | ------------------------------- |
| GET     | `/api/personas`                       | Personas listen                 |
| POST    | `/api/personas`                       | Persona erstellen               |
| GET     | `/api/personas/[id]`                  | Persona laden                   |
| PUT     | `/api/personas/[id]`                  | Persona aktualisieren           |
| DELETE  | `/api/personas/[id]`                  | Persona loeschen                |
| GET     | `/api/personas/[id]/files/[filename]` | Persona-Datei lesen             |
| PUT     | `/api/personas/[id]/files/[filename]` | Persona-Datei schreiben         |
| GET     | `/api/personas/templates`             | Templates laden                 |
| GET     | `/api/personas/[id]/telegram`         | Telegram-Bot-Status der Persona |
| POST    | `/api/personas/[id]/telegram`         | Telegram-Bot verbinden          |
| DELETE  | `/api/personas/[id]/telegram`         | Telegram-Bot trennen            |

---

## 4. Persona-gebundene Telegram Bots

Jede Persona kann optional einen eigenen Telegram-Bot-Token erhalten. Damit laeuft jede Persona auf einem separaten Bot.

### Einrichtung (UI)

Im Gateway-Tab der Persona-Einstellungen (`PersonaEditorPane`) gibt es die Sektion Telegram Bot:

1. Token aus `@BotFather` eintragen und auf Bot verbinden klicken.
2. Das System validiert den Token, waehlt Webhook oder Polling und zeigt den Bot-Benutzernamen an.
3. Trennen loescht den Webhook und stoppt den Poller.

### Verhalten bei eingehenden Nachrichten

- Ein `TelegramBotContext` (`{ botId, personaId, token }`) wird an die Inbound-Verarbeitung uebergeben.
- Die Konversation erhaelt automatisch die konfigurierte `personaId`.
- Globales Pairing-Gate wird fuer Persona-Bot-Nachrichten uebersprungen.

---

## 5. Verifikation

```bash
npm run test -- tests/integration/personas
npm run test -- tests/unit/channels/telegram-* tests/channels-pair-route.test.ts
npm run typecheck
npm run lint
```

---

## 6. Siehe auch

- `docs/API_REFERENCE.md`
- `docs/OMNICHANNEL_GATEWAY_SYSTEM.md`
- `docs/DEPLOYMENT_OPERATIONS.md`
