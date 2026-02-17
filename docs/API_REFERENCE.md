# API Referenz

**Stand:** 2026-02-17

## Überblick

Diese Referenz bildet den aktuellen Stand aller implementierten API-Routen unter `app/api/` ab.

- Runtime: Node.js (`export const runtime = 'nodejs'` in den Routen)
- Auth: Standardmäßig durch Session geschützt
- Parameter: Dynamische Segmente stehen in eckigen Klammern (z. B. `[id]`)

---

## Auth

| Methode | Pfad                      | Zweck             |
| ------- | ------------------------- | ----------------- |
| GET     | `/api/auth/[...nextauth]` | NextAuth Endpunkt |
| POST    | `/api/auth/[...nextauth]` | NextAuth Endpunkt |

---

## Channels und Messaging

### Channel-Verwaltung

| Methode | Pfad                  | Zweck                  |
| ------- | --------------------- | ---------------------- |
| GET     | `/api/channels/state` | Channel-Status laden   |
| POST    | `/api/channels/pair`  | Channel koppeln        |
| DELETE  | `/api/channels/pair`  | Channel entkoppeln     |
| GET     | `/api/channels/inbox` | Inbox aggregiert laden |

### Konversationen

| Methode | Pfad                          | Zweck                          |
| ------- | ----------------------------- | ------------------------------ |
| GET     | `/api/channels/conversations` | Konversationen auflisten       |
| POST    | `/api/channels/conversations` | Konversation erstellen         |
| PATCH   | `/api/channels/conversations` | Model-/Persona-Override setzen |
| DELETE  | `/api/channels/conversations` | Konversation löschen           |

### Messages

| Methode | Pfad                                 | Zweck                                |
| ------- | ------------------------------------ | ------------------------------------ |
| GET     | `/api/channels/messages`             | Nachrichten abrufen                  |
| POST    | `/api/channels/messages`             | Nachricht senden                     |
| GET     | `/api/channels/messages/attachments` | Attachment-Metadaten/Content abrufen |

### Webhooks

| Methode | Pfad                             | Zweck            |
| ------- | -------------------------------- | ---------------- |
| POST    | `/api/channels/telegram/webhook` | Telegram Inbound |
| POST    | `/api/channels/discord/webhook`  | Discord Inbound  |
| POST    | `/api/channels/whatsapp/webhook` | WhatsApp Inbound |
| POST    | `/api/channels/slack/webhook`    | Slack Inbound    |
| POST    | `/api/channels/imessage/webhook` | iMessage Inbound |

### Telegram Pairing

| Methode | Pfad                                     | Zweck                  |
| ------- | ---------------------------------------- | ---------------------- |
| POST    | `/api/channels/telegram/pairing/confirm` | Pairing bestätigen     |
| POST    | `/api/channels/telegram/pairing/poll`    | Polling-Trigger/Status |

---

## Rooms

| Methode | Pfad                                  | Zweck                   |
| ------- | ------------------------------------- | ----------------------- |
| GET     | `/api/rooms`                          | Rooms auflisten         |
| POST    | `/api/rooms`                          | Room erstellen          |
| GET     | `/api/rooms/[id]`                     | Room laden              |
| DELETE  | `/api/rooms/[id]`                     | Room löschen            |
| POST    | `/api/rooms/[id]/start`               | Room starten            |
| POST    | `/api/rooms/[id]/stop`                | Room stoppen            |
| GET     | `/api/rooms/[id]/state`               | Room-Status/State laden |
| GET     | `/api/rooms/[id]/messages`            | Room-Nachrichten laden  |
| POST    | `/api/rooms/[id]/messages`            | Room-Nachricht senden   |
| GET     | `/api/rooms/[id]/interventions`       | Interventionen laden    |
| POST    | `/api/rooms/[id]/interventions`       | Intervention erstellen  |
| POST    | `/api/rooms/[id]/members`             | Member hinzufügen       |
| PATCH   | `/api/rooms/[id]/members/[personaId]` | Member aktualisieren    |
| DELETE  | `/api/rooms/[id]/members/[personaId]` | Member entfernen        |
| GET     | `/api/rooms/membership-counts`        | Membership-Zähler laden |

---

## Personas

| Methode | Pfad                                  | Zweck                         |
| ------- | ------------------------------------- | ----------------------------- |
| GET     | `/api/personas`                       | Personas auflisten            |
| POST    | `/api/personas`                       | Persona erstellen             |
| GET     | `/api/personas/[id]`                  | Persona laden                 |
| PUT     | `/api/personas/[id]`                  | Persona aktualisieren         |
| DELETE  | `/api/personas/[id]`                  | Persona löschen               |
| GET     | `/api/personas/[id]/permissions`      | Persona-Berechtigungen lesen  |
| PUT     | `/api/personas/[id]/permissions`      | Persona-Berechtigungen setzen |
| GET     | `/api/personas/[id]/files/[filename]` | Persona-Datei lesen           |
| PUT     | `/api/personas/[id]/files/[filename]` | Persona-Datei schreiben       |
| GET     | `/api/personas/templates`             | Persona-Templates abrufen     |

---

## Worker

### Tasks

| Methode | Pfad                          | Zweck                                                        |
| ------- | ----------------------------- | ------------------------------------------------------------ |
| GET     | `/api/worker`                 | Tasks auflisten                                              |
| POST    | `/api/worker`                 | Task erstellen                                               |
| DELETE  | `/api/worker`                 | Bulk-Delete für Tasks                                        |
| GET     | `/api/worker/[id]`            | Task-Details laden                                           |
| PATCH   | `/api/worker/[id]`            | Task-Aktionen (cancel/resume/retry/approve/deny/assign/move) |
| DELETE  | `/api/worker/[id]`            | Task + Workspace löschen                                     |
| POST    | `/api/worker/[id]/test`       | Worker-Testlauf                                              |
| GET     | `/api/worker/[id]/activities` | Aktivitätsfeed laden                                         |

### Planning, Files, Export

| Methode | Pfad                               | Zweck                            |
| ------- | ---------------------------------- | -------------------------------- |
| GET     | `/api/worker/[id]/planning`        | Planung laden                    |
| POST    | `/api/worker/[id]/planning`        | Planung generieren               |
| POST    | `/api/worker/[id]/planning/answer` | Planungsfrage beantworten        |
| GET     | `/api/worker/[id]/files`           | Workspace-Dateien lesen          |
| POST    | `/api/worker/[id]/files`           | Datei im Workspace schreiben     |
| GET     | `/api/worker/[id]/export`          | Workspace als Archiv exportieren |

### Subagents, Deliverables, Workflow

| Methode | Pfad                            | Zweck                            |
| ------- | ------------------------------- | -------------------------------- |
| GET     | `/api/worker/[id]/subagents`    | Subagent-Sessions auflisten      |
| POST    | `/api/worker/[id]/subagents`    | Subagent-Session erstellen       |
| PATCH   | `/api/worker/[id]/subagents`    | Subagent-Status aktualisieren    |
| GET     | `/api/worker/[id]/deliverables` | Deliverables laden               |
| POST    | `/api/worker/[id]/deliverables` | Deliverable anlegen              |
| GET     | `/api/worker/[id]/workflow`     | Orchestra-Workflow-Ansicht laden |

### Worker Settings & Orchestra

| Methode | Pfad                                       | Zweck                                      |
| ------- | ------------------------------------------ | ------------------------------------------ |
| GET     | `/api/worker/settings`                     | Worker-Settings laden                      |
| PUT     | `/api/worker/settings`                     | Worker-Settings speichern                  |
| GET     | `/api/worker/orchestra/flows`              | Flows auflisten                            |
| POST    | `/api/worker/orchestra/flows`              | Draft-Flow erstellen                       |
| GET     | `/api/worker/orchestra/flows/[id]`         | Flow laden                                 |
| PATCH   | `/api/worker/orchestra/flows/[id]`         | Flow ändern                                |
| DELETE  | `/api/worker/orchestra/flows/[id]`         | Flow löschen                               |
| POST    | `/api/worker/orchestra/flows/[id]/publish` | Draft veröffentlichen                      |
| GET     | `/api/worker/openai/tools`                 | OpenAI-Worker Toolstatus laden             |
| PATCH   | `/api/worker/openai/tools`                 | OpenAI-Worker Tools/Approval aktualisieren |

---

## Skills & ClawHub

### Skills

| Methode | Pfad                         | Zweck                          |
| ------- | ---------------------------- | ------------------------------ |
| GET     | `/api/skills`                | Skills auflisten               |
| POST    | `/api/skills`                | Skill installieren             |
| PATCH   | `/api/skills/[id]`           | Skill aktiv/deaktiviert setzen |
| DELETE  | `/api/skills/[id]`           | Skill entfernen                |
| POST    | `/api/skills/execute`        | Skill ausführen                |
| GET     | `/api/skills/runtime-config` | Runtime-Config lesen           |
| PUT     | `/api/skills/runtime-config` | Runtime-Config setzen          |
| DELETE  | `/api/skills/runtime-config` | Runtime-Config löschen         |

### ClawHub

| Methode | Pfad                     | Zweck                             |
| ------- | ------------------------ | --------------------------------- |
| GET     | `/api/clawhub/search`    | ClawHub durchsuchen               |
| GET     | `/api/clawhub/explore`   | ClawHub explorieren               |
| GET     | `/api/clawhub/installed` | Installierte ClawHub-Skills       |
| POST    | `/api/clawhub/install`   | Skill installieren                |
| POST    | `/api/clawhub/update`    | Installierte Skills aktualisieren |
| GET     | `/api/clawhub/prompt`    | Prompt-Block für Skill-Kontext    |
| PATCH   | `/api/clawhub/[slug]`    | Skill-Enabled-State ändern        |
| DELETE  | `/api/clawhub/[slug]`    | Skill deinstallieren              |

---

## Model Hub

### Accounts

| Methode | Pfad                                         | Zweck                         |
| ------- | -------------------------------------------- | ----------------------------- |
| GET     | `/api/model-hub/accounts`                    | Accounts auflisten            |
| POST    | `/api/model-hub/accounts`                    | Account anlegen               |
| DELETE  | `/api/model-hub/accounts/[accountId]`        | Account löschen               |
| GET     | `/api/model-hub/accounts/[accountId]/models` | Modelle für Account laden     |
| POST    | `/api/model-hub/accounts/[accountId]/test`   | Connectivity-Test für Account |
| POST    | `/api/model-hub/accounts/test-all`           | Alle Accounts testen          |

### Gateway, Pipeline, Provider, OAuth

| Methode | Pfad                            | Zweck                           |
| ------- | ------------------------------- | ------------------------------- |
| POST    | `/api/model-hub/gateway`        | Dispatch über Fallback/Pipeline |
| GET     | `/api/model-hub/pipeline`       | Pipeline laden                  |
| POST    | `/api/model-hub/pipeline`       | Pipeline speichern              |
| PUT     | `/api/model-hub/pipeline`       | Pipeline ersetzen               |
| GET     | `/api/model-hub/providers`      | Provider-Katalog laden          |
| GET     | `/api/model-hub/oauth/start`    | OAuth-Start                     |
| GET     | `/api/model-hub/oauth/callback` | OAuth-Callback                  |

---

## Memory

| Methode | Pfad          | Zweck                                                       |
| ------- | ------------- | ----------------------------------------------------------- |
| GET     | `/api/memory` | Memory-Snapshot/History/Page lesen                          |
| POST    | `/api/memory` | Memory-FC-Aufruf (`core_memory_store`/`core_memory_recall`) |
| PUT     | `/api/memory` | Memory-Node aktualisieren/wiederherstellen                  |
| PATCH   | `/api/memory` | Massenupdate/-löschung                                      |
| DELETE  | `/api/memory` | Einzelnode oder Persona-Memory löschen                      |

---

## Automations

| Methode | Pfad                         | Zweck                    |
| ------- | ---------------------------- | ------------------------ |
| GET     | `/api/automations`           | Regeln auflisten         |
| POST    | `/api/automations`           | Regel erstellen          |
| GET     | `/api/automations/[id]`      | Regel laden              |
| PATCH   | `/api/automations/[id]`      | Regel aktualisieren      |
| DELETE  | `/api/automations/[id]`      | Regel löschen            |
| POST    | `/api/automations/[id]/run`  | Manuellen Run anlegen    |
| GET     | `/api/automations/[id]/runs` | Runs zur Regel auflisten |

---

## Config, Security, Health, Metrics

| Methode | Pfad                         | Zweck                           |
| ------- | ---------------------------- | ------------------------------- |
| GET     | `/api/config`                | Gateway-Konfiguration laden     |
| PUT     | `/api/config`                | Gateway-Konfiguration speichern |
| GET     | `/api/security/status`       | Security-Status-Snapshot        |
| GET     | `/api/health`                | Health-Check                    |
| GET     | `/api/doctor`                | Diagnostik-Check                |
| GET     | `/api/control-plane/metrics` | Control-Plane-Metriken          |

---

## Stats & Logs

| Methode | Pfad                     | Zweck               |
| ------- | ------------------------ | ------------------- |
| GET     | `/api/stats`             | Metriken laden      |
| GET     | `/api/stats/prompt-logs` | Prompt-Logs laden   |
| DELETE  | `/api/stats/prompt-logs` | Prompt-Logs löschen |
| GET     | `/api/logs`              | Logs laden          |
| DELETE  | `/api/logs`              | Logs löschen        |
| POST    | `/api/logs/ingest`       | Logs ingestieren    |

---

## Knowledge-Layer-Hinweis

Es gibt derzeit **keine** öffentlichen Knowledge-HTTP-Routen. Der Knowledge-Layer läuft intern über `src/server/knowledge/*` und wird über Konfiguration/Runtime aktiviert.

---

## Auth-Ausnahmen

Sessionfrei sind nur folgende Route-Familien:

- `/api/auth/[...nextauth]`
- Channel-Webhook-Routen unter dem Pfadpräfix `api/channels` mit dem Suffix `/webhook`
- `/api/health`
- `/api/doctor`

---

## Verifikation

```bash
npm run typecheck
npm run lint
npm run test
```
