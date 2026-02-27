# Master Agent System

**Status:** 2026-02-27  
**Scope:** Production-ready `Master` control plane with executable run flow, observability, and hardened connector/runtime paths.

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
- Productivity:
  - `GET/POST/PATCH/DELETE /api/master/notes`
  - `GET/POST/PATCH/DELETE /api/master/reminders`
- Observability:
  - `GET /api/master/metrics`
- Expansion:
  - `GET/POST /api/master/capabilities`
  - `GET/POST /api/master/toolforge` (`GET` optionally returns global shared catalog entries)

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
