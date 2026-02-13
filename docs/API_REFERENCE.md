# API Referenz

**Stand:** 2026-02-13

## Überblick

Dieses Dokument listet alle verfügbaren API-Routen des OpenClaw Gateway auf. Alle Routen erfordern Authentication (NextAuth), sofern nicht anders angegeben.

---

## Auth

| Methode | Pfad                      | Beschreibung       |
| ------- | ------------------------- | ------------------ |
| `*`     | `/api/auth/[...nextauth]` | NextAuth Catch-All |

---

## Channels (Omnichannel)

| Methode | Pfad                  | Beschreibung      |
| ------- | --------------------- | ----------------- |
| GET     | `/api/channels/state` | Channel-Status    |
| POST    | `/api/channels/pair`  | Channel koppeln   |
| DELETE  | `/api/channels/pair`  | Channel trennen   |
| GET     | `/api/channels/inbox` | Nachrichten-Inbox |

### Conversations

| Methode | Pfad                          | Beschreibung               |
| ------- | ----------------------------- | -------------------------- |
| GET     | `/api/channels/conversations` | Alle Konversationen        |
| DELETE  | `/api/channels/conversations` | Konversation löschen       |
| PATCH   | `/api/channels/conversations` | Konversation aktualisieren |

### Messages

| Methode | Pfad                     | Beschreibung        |
| ------- | ------------------------ | ------------------- |
| GET     | `/api/channels/messages` | Nachrichten abrufen |
| POST    | `/api/channels/messages` | Nachricht senden    |

### Channel-Webhooks

| Methode | Pfad                             | Beschreibung     |
| ------- | -------------------------------- | ---------------- |
| POST    | `/api/channels/telegram/webhook` | Telegram Webhook |
| POST    | `/api/channels/discord/webhook`  | Discord Webhook  |
| POST    | `/api/channels/whatsapp/webhook` | WhatsApp Webhook |
| POST    | `/api/channels/slack/webhook`    | Slack Webhook    |
| POST    | `/api/channels/imessage/webhook` | iMessage Webhook |

### Telegram Pairing

| Methode | Pfad                                     | Beschreibung            |
| ------- | ---------------------------------------- | ----------------------- |
| POST    | `/api/channels/telegram/pairing/confirm` | Pairing bestätigen      |
| GET     | `/api/channels/telegram/pairing/poll`    | Pairing-Status abfragen |

---

## Rooms

| Methode | Pfad                                  | Beschreibung           |
| ------- | ------------------------------------- | ---------------------- |
| GET     | `/api/rooms`                          | Alle Rooms             |
| POST    | `/api/rooms`                          | Room erstellen         |
| GET     | `/api/rooms/[id]`                     | Room-Details           |
| DELETE  | `/api/rooms/[id]`                     | Room löschen           |
| POST    | `/api/rooms/[id]/start`               | Room starten           |
| POST    | `/api/rooms/[id]/stop`                | Room stoppen           |
| GET     | `/api/rooms/[id]/state`               | Room-State             |
| GET     | `/api/rooms/[id]/messages`            | Room-Nachrichten       |
| POST    | `/api/rooms/[id]/messages`            | Nachricht an Room      |
| GET     | `/api/rooms/[id]/interventions`       | Interventionen         |
| POST    | `/api/rooms/[id]/interventions`       | Intervention erstellen |
| POST    | `/api/rooms/[id]/members`             | Member hinzufügen      |
| DELETE  | `/api/rooms/[id]/members/[personaId]` | Member entfernen       |

---

## Personas

| Methode | Pfad                                  | Beschreibung           |
| ------- | ------------------------------------- | ---------------------- |
| GET     | `/api/personas`                       | Alle Personas          |
| POST    | `/api/personas`                       | Persona erstellen      |
| GET     | `/api/personas/[id]`                  | Persona-Details        |
| DELETE  | `/api/personas/[id]`                  | Persona löschen        |
| PATCH   | `/api/personas/[id]`                  | Persona aktualisieren  |
| GET     | `/api/personas/[id]/files`            | Persona-Dateien        |
| GET     | `/api/personas/[id]/files/[filename]` | Persona-Datei          |
| GET     | `/api/personas/[id]/permissions`      | Persona-Berechtigungen |
| POST    | `/api/personas/[id]/permissions`      | Berechtigung setzen    |
| GET     | `/api/personas/templates`             | Persona-Vorlagen       |
| POST    | `/api/personas/templates`             | Vorlage erstellen      |

---

## Worker

| Methode | Pfad                      | Beschreibung          |
| ------- | ------------------------- | --------------------- |
| GET     | `/api/worker`             | Alle Tasks            |
| POST    | `/api/worker`             | Task erstellen        |
| GET     | `/api/worker/[id]`        | Task-Details          |
| DELETE  | `/api/worker/[id]`        | Task löschen          |
| POST    | `/api/worker/[id]/start`  | Task starten          |
| POST    | `/api/worker/[id]/stop`   | Task stoppen          |
| GET     | `/api/worker/[id]/files`  | Workspace-Dateien     |
| POST    | `/api/worker/[id]/export` | Workspace exportieren |

---

## Skills

| Methode | Pfad                  | Beschreibung         |
| ------- | --------------------- | -------------------- |
| GET     | `/api/skills`         | Alle Skills          |
| POST    | `/api/skills`         | Skill installieren   |
| GET     | `/api/skills/[id]`    | Skill-Details        |
| DELETE  | `/api/skills/[id]`    | Skill deinstallieren |
| POST    | `/api/skills/execute` | Skill ausführen      |

---

## Model Hub

### Accounts

| Methode | Pfad                                         | Beschreibung         |
| ------- | -------------------------------------------- | -------------------- |
| GET     | `/api/model-hub/accounts`                    | Alle Accounts        |
| POST    | `/api/model-hub/accounts`                    | Account hinzufügen   |
| GET     | `/api/model-hub/accounts/[accountId]`        | Account-Details      |
| DELETE  | `/api/model-hub/accounts/[accountId]`        | Account löschen      |
| GET     | `/api/model-hub/accounts/[accountId]/models` | Modelle des Accounts |
| POST    | `/api/model-hub/accounts/[accountId]/test`   | Account testen       |
| POST    | `/api/model-hub/accounts/test-all`           | Alle Accounts testen |

### Gateway

| Methode | Pfad                     | Beschreibung      |
| ------- | ------------------------ | ----------------- |
| POST    | `/api/model-hub/gateway` | KI-Anfrage senden |

### Pipeline

| Methode | Pfad                      | Beschreibung       |
| ------- | ------------------------- | ------------------ |
| POST    | `/api/model-hub/pipeline` | Pipeline ausführen |

### Providers

| Methode | Pfad                       | Beschreibung        |
| ------- | -------------------------- | ------------------- |
| GET     | `/api/model-hub/providers` | Verfügbare Provider |

### OAuth

| Methode | Pfad                            | Beschreibung   |
| ------- | ------------------------------- | -------------- |
| GET     | `/api/model-hub/oauth/start`    | OAuth starten  |
| GET     | `/api/model-hub/oauth/callback` | OAuth Callback |

---

## Memory

| Methode | Pfad          | Beschreibung     |
| ------- | ------------- | ---------------- |
| GET     | `/api/memory` | Memories abrufen |
| POST    | `/api/memory` | Memory speichern |

---

## Security

| Methode | Pfad                   | Beschreibung    |
| ------- | ---------------------- | --------------- |
| GET     | `/api/security/status` | Security-Status |

---

## ClawHub

| Methode | Pfad                     | Beschreibung         |
| ------- | ------------------------ | -------------------- |
| GET     | `/api/clawhub/search`    | ClawHub durchsuchen  |
| GET     | `/api/clawhub/explore`   | ClawHub erkunden     |
| GET     | `/api/clawhub/installed` | Installierte Skills  |
| POST    | `/api/clawhub/install`   | Skill installieren   |
| POST    | `/api/clawhub/update`    | Skill updaten        |
| GET     | `/api/clawhub/[slug]`    | Skill-Details        |
| POST    | `/api/clawhub/prompt`    | Prompt-Block abrufen |

---

## Control Plane

| Methode | Pfad                         | Beschreibung    |
| ------- | ---------------------------- | --------------- |
| GET     | `/api/control-plane/metrics` | System-Metriken |

---

## Automations

| Methode | Pfad                                 | Beschreibung         |
| ------- | ------------------------------------ | -------------------- |
| GET     | `/api/automations`                   | Alle Automations     |
| POST    | `/api/automations`                   | Automation erstellen |
| GET     | `/api/automations/[id]`              | Automation-Details   |
| DELETE  | `/api/automations/[id]`              | Automation löschen   |
| POST    | `/api/automations/[id]/run`          | Automation ausführen |
| GET     | `/api/automations/[id]/runs`         | Alle Runs            |
| GET     | `/api/automations/[id]/runs/[runId]` | Run-Details          |

---

## Stats

| Methode | Pfad                     | Beschreibung |
| ------- | ------------------------ | ------------ |
| GET     | `/api/stats`             | Statistiken  |
| GET     | `/api/stats/prompt-logs` | Prompt-Logs  |

---

## Health & Doctor

| Methode | Pfad          | Beschreibung |
| ------- | ------------- | ------------ |
| GET     | `/api/health` | Health-Check |
| GET     | `/api/doctor` | Diagnose     |

---

## Logs

| Methode | Pfad               | Beschreibung     |
| ------- | ------------------ | ---------------- |
| GET     | `/api/logs`        | Logs abrufen     |
| POST    | `/api/logs/ingest` | Log ingestieren  |
| GET     | `/api/logs/stream` | Log-Stream (SSE) |

---

## WebSocket Gateway

| Event                  | Beschreibung           |
| ---------------------- | ---------------------- |
| `room.message`         | Room-Nachricht         |
| `room.member.status`   | Member-Status-Update   |
| `room.run.status`      | Run-Status-Update      |
| `room.intervention`    | Intervention           |
| `room.metrics`         | Metriken               |
| `conversation.new`     | Neue Konversation      |
| `conversation.deleted` | Gelöschte Konversation |
| `chat.typing`          | Tippen-Indikator       |
| `worker.status`        | Worker-Status          |

### RPC-Methoden

| Methode           | Parameter                                       | Beschreibung          |
| ----------------- | ----------------------------------------------- | --------------------- |
| `chat.send`       | `{ conversationId, content, clientMessageId? }` | Nachricht senden      |
| `chat.stream`     | `{ conversationId, content }`                   | Streaming-Nachricht   |
| `chat.abort`      | `{ conversationId }`                            | Generierung abbrechen |
| `sessions.delete` | `{ conversationId }`                            | Session löschen       |
| `sessions.reset`  | `{ title? }`                                    | Session zurücksetzen  |
| `sessions.patch`  | `{ conversationId, modelOverride? }`            | Session-Update        |
| `channels.list`   | -                                               | Channel-Liste         |
| `channels.pair`   | `{ channel, token? }`                           | Channel koppeln       |
| `channels.unpair` | `{ channel }`                                   | Channel trennen       |
| `inbox.list`      | `{ channel?, q?, limit? }`                      | Inbox-Liste           |

---

## Auth-Anforderungen

Alle Routen unter `/api/` erfordern eine gültige Session, außer:

- `/api/auth/[...nextauth]` (Auth本身)
- `/api/channels/*/webhook` (Webhooks)
- `/api/health` (Health-Check)
- `/api/doctor` (Diagnose)

---

## Fehlercodes

| Code             | HTTP | Beschreibung             |
| ---------------- | ---- | ------------------------ |
| `UNAUTHORIZED`   | 401  | Nicht authentifiziert    |
| `FORBIDDEN`      | 403  | Keine Berechtigung       |
| `NOT_FOUND`      | 404  | Ressource nicht gefunden |
| `INVALID_INPUT`  | 400  | Ungültige Eingabe        |
| `INTERNAL_ERROR` | 500  | Server-Fehler            |

---

## Verifikation

```bash
npm run typecheck
npm run lint
npm run test
```

---

## Siehe auch

- [docs/README.md](README.md) – Dokumentations-Index
- [docs/CORE_HANDBOOK.md](CORE_HANDBOOK.md) – Technischer Überblick
