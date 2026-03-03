# API Reference

## Metadata

- Purpose: Verbindliche Referenz aller aktuell implementierten HTTP-API-Routen unter `app/api` mit exportierten Methoden.
- Scope: Route-/Methoden-Katalog, Domain-Gruppierung, Runtime-Hinweise zum aktuellen Systemzustand.
- Source of Truth: This document is derived from `app/api/**/route.ts` and overrides archived API documents on conflicts.
- Last Reviewed: 2026-03-03
- Related Runbooks: docs/runbooks/chat-cli-smoke-approval.md, docs/runbooks/gateway-config-production-rollout.md

---

## Overview

Diese Referenz beschreibt den **aktuellen** API-Stand der Codebasis.

- Basis: `/api`
- Quelle: exportierte Methoden in `app/api/**/route.ts`
- Hinweis: Der fruehere Worker-API-Bereich (`/api/worker/*`) ist im aktuellen Stand entfernt und daher hier bewusst nicht enthalten.

## Domain Summary

| Domain        | Routes |
| ------------- | -----: |
| auth          |      1 |
| automations   |      6 |
| channels      |     15 |
| clawhub       |      7 |
| config        |      1 |
| control-plane |      1 |
| debug         |      3 |
| doctor        |      1 |
| health        |      2 |
| knowledge     |      1 |
| logs          |      2 |
| master        |     12 |
| memory        |      1 |
| model-hub     |     10 |
| ops           |      4 |
| personas      |      4 |
| security      |      2 |
| skills        |      4 |
| stats         |      2 |

## Route Catalog

### /api/auth

| Methods   | Route                   |
| --------- | ----------------------- |
| GET, POST | /api/auth/[...nextauth] |

### /api/automations

| Methods            | Route                      |
| ------------------ | -------------------------- |
| GET, POST          | /api/automations           |
| DELETE, GET, PATCH | /api/automations/[id]      |
| GET, PUT           | /api/automations/[id]/flow |
| POST               | /api/automations/[id]/run  |
| GET                | /api/automations/[id]/runs |
| GET                | /api/automations/metrics   |

### /api/debug

| Methods | Route                                |
| ------- | ------------------------------------ |
| GET     | /api/debug/conversations             |
| POST    | /api/debug/conversations/[id]/replay |
| GET     | /api/debug/conversations/[id]/turns  |

### /api/channels

| Methods                  | Route                                       |
| ------------------------ | ------------------------------------------- |
| DELETE, GET, PATCH, POST | /api/channels/conversations                 |
| POST                     | /api/channels/discord/webhook               |
| POST                     | /api/channels/imessage/webhook              |
| GET                      | /api/channels/inbox                         |
| GET, POST                | /api/channels/messages                      |
| GET                      | /api/channels/messages/attachments          |
| DELETE, POST             | /api/channels/pair                          |
| POST                     | /api/channels/slack/webhook                 |
| GET                      | /api/channels/state                         |
| POST                     | /api/channels/telegram/bots/[botId]/webhook |
| POST                     | /api/channels/telegram/pairing/confirm      |
| POST                     | /api/channels/telegram/pairing/poll         |
| POST                     | /api/channels/telegram/webhook              |
| GET, PUT                 | /api/channels/whatsapp/accounts             |
| POST                     | /api/channels/whatsapp/webhook              |

### /api/clawhub

| Methods       | Route                  |
| ------------- | ---------------------- |
| DELETE, PATCH | /api/clawhub/[slug]    |
| GET           | /api/clawhub/explore   |
| POST          | /api/clawhub/install   |
| GET           | /api/clawhub/installed |
| GET           | /api/clawhub/prompt    |
| GET           | /api/clawhub/search    |
| POST          | /api/clawhub/update    |

### /api/config

| Methods  | Route       |
| -------- | ----------- |
| GET, PUT | /api/config |

### /api/control-plane

| Methods | Route                      |
| ------- | -------------------------- |
| GET     | /api/control-plane/metrics |

### /api/doctor

| Methods | Route       |
| ------- | ----------- |
| GET     | /api/doctor |

### /api/health

| Methods | Route                 |
| ------- | --------------------- |
| GET     | /api/health           |
| GET     | /api/health/scheduler |

### /api/knowledge

| Methods | Route                |
| ------- | -------------------- |
| GET     | /api/knowledge/graph |

### /api/logs

| Methods     | Route            |
| ----------- | ---------------- |
| DELETE, GET | /api/logs        |
| POST        | /api/logs/ingest |

### /api/master

| Methods | Route                             |
| ------- | --------------------------------- |
| GET     | /api/master/capabilities          |
| POST    | /api/master/capabilities          |
| GET     | /api/master/metrics               |
| GET     | /api/master/notes                 |
| POST    | /api/master/notes                 |
| PATCH   | /api/master/notes                 |
| DELETE  | /api/master/notes                 |
| GET     | /api/master/reminders             |
| POST    | /api/master/reminders             |
| PATCH   | /api/master/reminders             |
| DELETE  | /api/master/reminders             |
| POST    | /api/master/gmail                 |
| GET     | /api/master/toolforge             |
| POST    | /api/master/toolforge             |
| POST    | /api/master/voice-session         |
| GET     | /api/master/runs                  |
| POST    | /api/master/runs                  |
| GET     | /api/master/runs/[id]             |
| PATCH   | /api/master/runs/[id]             |
| POST    | /api/master/runs/[id]/actions     |
| GET     | /api/master/runs/[id]/delegations |
| POST    | /api/master/runs/[id]/delegations |
| POST    | /api/master/runs/[id]/feedback    |

### /api/memory

| Methods                       | Route       |
| ----------------------------- | ----------- |
| DELETE, GET, PATCH, POST, PUT | /api/memory |

### /api/model-hub

| Methods        | Route                                      |
| -------------- | ------------------------------------------ |
| GET, POST      | /api/model-hub/accounts                    |
| DELETE         | /api/model-hub/accounts/[accountId]        |
| GET            | /api/model-hub/accounts/[accountId]/models |
| POST           | /api/model-hub/accounts/[accountId]/test   |
| POST           | /api/model-hub/accounts/test-all           |
| POST           | /api/model-hub/gateway                     |
| GET            | /api/model-hub/oauth/callback              |
| GET            | /api/model-hub/oauth/start                 |
| GET, POST, PUT | /api/model-hub/pipeline                    |
| GET            | /api/model-hub/providers                   |

### /api/ops

| Methods   | Route              |
| --------- | ------------------ |
| GET       | /api/ops/agents    |
| GET       | /api/ops/instances |
| GET, POST | /api/ops/nodes     |
| GET       | /api/ops/sessions  |

### /api/personas

| Methods          | Route                               |
| ---------------- | ----------------------------------- |
| GET, POST        | /api/personas                       |
| DELETE, GET, PUT | /api/personas/[id]                  |
| GET, PUT         | /api/personas/[id]/files/[filename] |
| GET              | /api/personas/templates             |

### /api/security

| Methods | Route                        |
| ------- | ---------------------------- |
| GET     | /api/security/policy-explain |
| GET     | /api/security/status         |

### /api/skills

| Methods          | Route                      |
| ---------------- | -------------------------- |
| GET, POST        | /api/skills                |
| DELETE, PATCH    | /api/skills/[id]           |
| POST             | /api/skills/execute        |
| DELETE, GET, PUT | /api/skills/runtime-config |

### /api/stats

| Methods     | Route                  |
| ----------- | ---------------------- |
| GET         | /api/stats             |
| DELETE, GET | /api/stats/prompt-logs |

## Notes

- Auth route (`/api/auth/[...nextauth]`) wird ueber Handler-Aliase (`GET`, `POST`) exportiert.
- Security-Policy-Erklaerung ist aktiv unter `/api/security/policy-explain`.
- Knowledge-Graph ist als eigene Read-Route aktiv unter `/api/knowledge/graph`.
- Ops-Endpoints (`/api/ops/*`) sind der aktuelle operative Ersatz fuer fruehere Worker-Management-Routen.
- `/api/automations/[id]/flow` verwaltet den visuellen `flowGraph` (GET/PUT) fuer Automation-Regeln.
- Debug-Endpoints (`/api/debug/*`) liefern Conversation-Turn-Analysen und Replay fuer technische Diagnose.
- `/api/channels/telegram/bots/[botId]/webhook` — Eingehende Updates für persona-gebundene Bots mit eigenem Webhook-Secret pro Bot.
- Master-Endpoints (`/api/master/*`) steuern den Master Agent: Runs, Notes, Reminders, Gmail, ToolForge, Capabilities und Metriken.
- `/api/master/runs/[id]/actions` unterstuetzt Run-Controls (`run.start`, `run.tick`, `run.cancel`, `run.export`) sowie Approval-Entscheidungen (`approve_once`, `approve_always`, `deny`).
- `/api/master/runs/[id]/feedback` ermoeglicht Feedback zu abgeschlossenen Runs.
