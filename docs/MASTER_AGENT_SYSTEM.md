# Master Agent System

## Metadata

- Purpose: Authoritative reference for the Master control plane runtime, contracts, APIs, and workspace isolation behavior.
- Scope: Production-ready `Master` vertical slice with run lifecycle, approvals, delegations, observability, and voice-session integration.
- Source of Truth: `app/api/master/*`, `src/server/master/*`, `src/modules/master/*`.
- Last Reviewed: 2026-03-04
- Related Runbooks: N/A

## Overview

The Master Agent is implemented as a separate vertical slice and does not change Agent Room behavior.

- UI: `View.MASTER` + `src/modules/master/components/*`
- API: `app/api/master/*`
- Domain/runtime: `src/server/master/*`
- Storage: SQLite tables `master_*` in `src/server/master/migrations.ts`

Agent Room remains chat-only.

## Core Contracts

- Approval modes: `approve_once`, `approve_always`, `deny`
- Pause contract: unresolved high-risk actions move run to `AWAITING_APPROVAL`
- Gmail send contract: `send` always requires approval
- Workspace isolation: each run is bound to persona workspace scope via `resolveMasterWorkspaceScope`
- Side effects: idempotency keys + action ledger (`master_action_ledger`) provide replay-safe execution

## Runtime Topology

- Control plane:
  - `MasterOrchestrator` controls lifecycle and approvals
  - user interactions remain responsive during delegation
- Worker plane:
  - delegation dispatcher, inbox, subagent pool, aggregation, recovery
  - policy gates: cooldown/capacity/budget reasons are explicit
  - autonomous execution runtime runs task plans in background without blocking UI interactions

## Capability and Learning

- Inventory bootstrap and confidence scoring:
  - `capabilities/inventory.ts`
- Understanding loop:
  - `capabilities/understandingLoop.ts`
  - scheduled window check at `03:00` (UTC-based check in code)
- Maintenance scheduler:
  - `runMasterMaintenanceTick` executes once per day per workspace scope
  - skips scopes with active runs to keep learning preemptible
- Apprenticeship:
  - proposal templates + approval-ready connector proposals
- Tool Forge:
  - validation -> sandbox checks -> approval -> optional global publish

## Gmail and Secrets

- Gmail connector:
  - `connectors/gmail/{oauth,client,actions}.ts`
  - action API: `POST /api/master/gmail`
  - supports `connect`, `revoke`, `read`, `search`, `draft`, `send`
  - client supports mock mode for deterministic tests and real Gmail REST mode in production
- Secret lifecycle:
  - encrypted-at-rest token payloads (`enc:v2` AES-256-GCM)
  - rotate/revoke helpers with audit-friendly metadata
  - audit events persisted in `master_audit_events`

## API Surface

- Runs:
  - `GET/POST /api/master/runs`
  - `GET/PATCH /api/master/runs/[id]`
  - `POST /api/master/runs/[id]/actions`
    - run controls: `run.start`, `run.tick`, `run.cancel`, `run.export`
    - approval controls for side effects remain `approve_once|approve_always|deny`
  - `GET/POST /api/master/runs/[id]/delegations`
  - `POST /api/master/runs/[id]/feedback`
    - stores completed-run feedback (`rating`, `policy`, optional `comment`)
- Productivity:
  - `GET/POST/PATCH/DELETE /api/master/notes`
  - `GET/POST/PATCH/DELETE /api/master/reminders`
- Observability:
  - `GET /api/master/metrics`

## Voice Session Runtime

- Token endpoint: `GET /api/master/voice-session`
  - Guarded via `withUserContext(...)`
  - Resolves xAI key from Model Hub account storage
  - Requests ephemeral realtime client secret from `https://api.x.ai/v1/realtime/client_secrets`
- Frontend hook: `src/modules/master/voice/grok/useGrokVoiceAgent.ts`
  - Lazy connect: no eager websocket connect on mount
  - One-turn policy: auto-disconnect is scheduled after `response.output_audio.done` / `response.done`
  - Output audio stream is exposed via `subscribeOutputAudio(...)` for avatar rendering

## UI Utility

- `MasterView` is now task-operational:
  - persona/workspace scope selection
  - contract creation (`Create Master Run`)
  - run start and export controls
  - approval decision submission (`approve_once`, `approve_always`, `deny`)
  - live metrics + polling status

## Verification Snapshot

Validated in this implementation:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test -- tests/unit/master tests/integration/master`
- `npm test` (full suite)
