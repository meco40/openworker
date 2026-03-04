# API Reference

## Metadata

- Purpose: Verbindliche Referenz aller aktuell implementierten HTTP-API-Routen unter `app/api` mit exportierten Methoden.
- Scope: Route-/Methoden-Katalog und Domain-Gruppierung zum aktuellen Systemzustand.
- Source of Truth: This document is derived from `app/api/**/route.ts` and overrides archived API documents on conflicts.
- Last Reviewed: 2026-03-04
- Related Runbooks: docs/runbooks/chat-cli-smoke-approval.md, docs/runbooks/gateway-config-production-rollout.md

---

## Overview

Diese Referenz beschreibt den **aktuellen** API-Stand der Codebasis.

- Basis: `/api`
- Quelle: exportierte Methoden in `app/api/**/route.ts`
- Anzahl Routen: 103

## Domain Summary

| Domain          | Routes |
| --------------- | -----: |
| agents          |      5 |
| auth            |      1 |
| automations     |      6 |
| channels        |     13 |
| clawhub         |      6 |
| config          |      1 |
| control-plane   |      1 |
| debug           |      3 |
| doctor          |      1 |
| events          |      2 |
| files           |      2 |
| health          |      2 |
| knowledge       |      1 |
| logs            |      2 |
| master          |     10 |
| memory          |      1 |
| mission-control |      1 |
| model-hub       |     10 |
| openclaw        |      4 |
| ops             |      4 |
| personas        |      4 |
| security        |      2 |
| skills          |      5 |
| stats           |      2 |
| tasks           |     11 |
| webhooks        |      1 |
| workspaces      |      2 |

## Route Catalog

### /api/agents

| Methods            | Route                     |
| ------------------ | ------------------------- |
| GET, POST          | /api/agents               |
| GET, PATCH, DELETE | /api/agents/[id]          |
| GET, POST, DELETE  | /api/agents/[id]/openclaw |
| GET                | /api/agents/discover      |
| POST               | /api/agents/import        |

### /api/auth

| Methods   | Route                   |
| --------- | ----------------------- |
| GET, POST | /api/auth/[...nextauth] |

### /api/automations

| Methods            | Route                      |
| ------------------ | -------------------------- |
| GET, POST          | /api/automations           |
| GET, PATCH, DELETE | /api/automations/[id]      |
| GET, PUT           | /api/automations/[id]/flow |
| POST               | /api/automations/[id]/run  |
| GET                | /api/automations/[id]/runs |
| GET                | /api/automations/metrics   |

### /api/channels

| Methods                  | Route                                       |
| ------------------------ | ------------------------------------------- |
| GET, POST, PATCH, DELETE | /api/channels/conversations                 |
| GET                      | /api/channels/inbox                         |
| GET, POST, DELETE        | /api/channels/messages                      |
| GET                      | /api/channels/messages/attachments          |
| POST, DELETE             | /api/channels/pair                          |
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
| PATCH, DELETE | /api/clawhub/[slug]    |
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

### /api/debug

| Methods | Route                                |
| ------- | ------------------------------------ |
| GET     | /api/debug/conversations             |
| POST    | /api/debug/conversations/[id]/replay |
| GET     | /api/debug/conversations/[id]/turns  |

### /api/doctor

| Methods | Route       |
| ------- | ----------- |
| GET     | /api/doctor |

### /api/events

| Methods   | Route              |
| --------- | ------------------ |
| GET, POST | /api/events        |
| GET       | /api/events/stream |

### /api/files

| Methods | Route              |
| ------- | ------------------ |
| GET     | /api/files/preview |
| POST    | /api/files/reveal  |

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
| GET, DELETE | /api/logs        |
| POST        | /api/logs/ingest |

### /api/master

| Methods                  | Route                             |
| ------------------------ | --------------------------------- |
| POST                     | /api/master/gmail                 |
| GET                      | /api/master/metrics               |
| GET, POST, PATCH, DELETE | /api/master/notes                 |
| GET, POST, PATCH, DELETE | /api/master/reminders             |
| GET, POST                | /api/master/runs                  |
| GET, PATCH               | /api/master/runs/[id]             |
| POST                     | /api/master/runs/[id]/actions     |
| GET, POST                | /api/master/runs/[id]/delegations |
| POST                     | /api/master/runs/[id]/feedback    |
| GET                      | /api/master/voice-session         |

### /api/memory

| Methods                       | Route       |
| ----------------------------- | ----------- |
| GET, POST, PUT, PATCH, DELETE | /api/memory |

### /api/mission-control

| Methods | Route                       |
| ------- | --------------------------- |
| GET     | /api/mission-control/status |

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

### /api/openclaw

| Methods                  | Route                       |
| ------------------------ | --------------------------- |
| GET                      | /api/openclaw/models        |
| GET, POST                | /api/openclaw/sessions      |
| GET, POST, PATCH, DELETE | /api/openclaw/sessions/[id] |
| GET                      | /api/openclaw/status        |

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
| GET, PUT, DELETE | /api/personas/[id]                  |
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
| PATCH, DELETE    | /api/skills/[id]           |
| POST             | /api/skills/execute        |
| GET, POST        | /api/skills/external-host  |
| GET, PUT, DELETE | /api/skills/runtime-config |

### /api/stats

| Methods     | Route                  |
| ----------- | ---------------------- |
| GET         | /api/stats             |
| GET, DELETE | /api/stats/prompt-logs |

### /api/tasks

| Methods            | Route                                   |
| ------------------ | --------------------------------------- |
| GET, POST          | /api/tasks                              |
| GET, PATCH, DELETE | /api/tasks/[id]                         |
| GET, POST          | /api/tasks/[id]/activities              |
| GET, POST          | /api/tasks/[id]/deliverables            |
| POST               | /api/tasks/[id]/dispatch                |
| GET, POST, DELETE  | /api/tasks/[id]/planning                |
| POST               | /api/tasks/[id]/planning/answer         |
| GET                | /api/tasks/[id]/planning/poll           |
| POST               | /api/tasks/[id]/planning/retry-dispatch |
| GET, POST          | /api/tasks/[id]/subagent                |
| GET, POST          | /api/tasks/[id]/test                    |

### /api/webhooks

| Methods   | Route                          |
| --------- | ------------------------------ |
| GET, POST | /api/webhooks/agent-completion |

### /api/workspaces

| Methods            | Route                |
| ------------------ | -------------------- |
| GET, POST          | /api/workspaces      |
| GET, PATCH, DELETE | /api/workspaces/[id] |

## Notes

- `UNCONFIRMED` bedeutet: Die HTTP-Methode wird in der Route indirekt exportiert und konnte nicht statisch über Funktions-/Konstanten-Exports erkannt werden.
- Auth route (`/api/auth/[...nextauth]`) exportiert Methoden via Alias (`handler as GET/POST`).
- Diese Datei ist absichtlich route-zentriert; fachliche Semantik steht in den jeweiligen Domain-Dokumenten unter `docs/*_SYSTEM.md`.
