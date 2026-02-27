# Master Agent System

**Status:** 2026-02-27  
**Scope:** Production-ready baseline for the dedicated `Master` page and runtime.

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

## Capability and Learning

- Inventory bootstrap and confidence scoring:
  - `capabilities/inventory.ts`
- Understanding loop:
  - `capabilities/understandingLoop.ts`
  - scheduled window check at `03:00` (UTC-based check in code)
- Apprenticeship:
  - proposal templates + approval-ready connector proposals
- Tool Forge:
  - validation -> sandbox checks -> approval -> optional global publish

## Gmail and Secrets

- Gmail connector:
  - `connectors/gmail/{oauth,client,actions}.ts`
  - action API: `POST /api/master/gmail`
- Secret lifecycle:
  - encrypted-at-rest token payloads
  - rotate/revoke helpers with audit-friendly metadata

## API Surface

- Runs:
  - `GET/POST /api/master/runs`
  - `GET/PATCH /api/master/runs/[id]`
  - `POST /api/master/runs/[id]/actions`
  - `GET/POST /api/master/runs/[id]/delegations`
- Productivity:
  - `GET/POST/PATCH/DELETE /api/master/notes`
  - `GET/POST/PATCH/DELETE /api/master/reminders`
- Expansion:
  - `GET/POST /api/master/capabilities`
  - `GET/POST /api/master/toolforge`

## Verification Snapshot

Validated in this implementation:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test -- tests/unit/master tests/integration/master`
