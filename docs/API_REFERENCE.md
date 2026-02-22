# API Reference

## Metadata

- Purpose: Verbindliche Referenz aller aktuell implementierten HTTP-API-Routen unter `app/api` mit exportierten Methoden.
- Scope: Route-/Methoden-Katalog, Domain-Gruppierung, Runtime-Hinweise zum aktuellen Systemzustand.
- Source of Truth: This document is derived from `app/api/**/route.ts` and overrides archived API documents on conflicts.
- Last Reviewed: 2026-02-22
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
| automations   |      5 |
| channels      |     15 |
| clawhub       |      7 |
| config        |      1 |
| control-plane |      1 |
| doctor        |      1 |
| health        |      1 |
| knowledge     |      1 |
| logs          |      2 |
| memory        |      1 |
| model-hub     |     10 |
| ops           |      4 |
| personas      |      5 |
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
| POST               | /api/automations/[id]/run  |
| GET                | /api/automations/[id]/runs |
| GET                | /api/automations/metrics   |

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

| Methods | Route       |
| ------- | ----------- |
| GET     | /api/health |

### /api/knowledge

| Methods | Route                |
| ------- | -------------------- |
| GET     | /api/knowledge/graph |

### /api/logs

| Methods     | Route            |
| ----------- | ---------------- |
| DELETE, GET | /api/logs        |
| POST        | /api/logs/ingest |

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

| Methods           | Route                               |
| ----------------- | ----------------------------------- |
| GET, POST         | /api/personas                       |
| DELETE, GET, PUT  | /api/personas/[id]                  |
| GET, PUT          | /api/personas/[id]/files/[filename] |
| DELETE, GET, POST | /api/personas/[id]/telegram         |
| GET               | /api/personas/templates             |

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
- `/api/personas/[id]/telegram` — Persona-gebundene Telegram-Bot-Verwaltung: `GET` liefert Bot-Status (kein Token), `POST` verbindet einen neuen Bot per Token, `DELETE` trennt den Bot.
- `/api/channels/telegram/bots/[botId]/webhook` — Eingehende Updates für persona-gebundene Bots mit eigenem Webhook-Secret pro Bot.
