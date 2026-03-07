# Master Agent System

## Metadata

- Purpose: Authoritative reference for the Master control plane runtime, contracts, APIs, and workspace isolation behavior.
- Scope: Production-ready `Master` vertical slice with run lifecycle, approvals, delegations, observability, and voice-session integration.
- Source of Truth: `app/api/master/*`, `src/server/master/*`, `src/modules/master/*`.
- Last Reviewed: 2026-03-06
- Related Runbooks: `docs/runbooks/master-autonomy-rollout.md`
- User Guide: `docs/MASTER_PAGE_GUIDE.md`

## Overview

The Master Agent is implemented as a dedicated vertical slice with a system-persona front end and a guarded runtime back end. It does not change Agent Room execution behavior.

- UI: `View.MASTER` + `src/modules/master/components/*`
- API: `app/api/master/*`
- Domain/runtime: `src/server/master/*`
- Storage: SQLite tables `master_*` in `src/server/master/migrations.ts`
- System persona: `Master` is provisioned per user via `ensureMasterPersona(...)` with `systemPersonaKey='master'`
- Rollout gate: `MASTER_SYSTEM_PERSONA_ENABLED`
  - enabled or unset: Master uses the fixed system persona plus `Master > Settings`
  - disabled (`0|false|off|no`): Master falls back to legacy persona-scoped runs and `/api/master/settings` returns `404`
- Runtime gates:
  - `MASTER_GENERIC_RUNTIME_ENABLED`
  - `MASTER_APPROVAL_CONTROL_PLANE_ENABLED`
  - `MASTER_SUBAGENT_SESSIONS_ENABLED`
  - `MASTER_OPERATOR_EVENTS_ENABLED`

Agent Room remains chat-only.

## Core Contracts

- Approval modes: `approve_once`, `approve_always`, `deny`
- Pause contract: unresolved high-risk actions move run to `AWAITING_APPROVAL`
- Gmail send contract: `send` always requires approval
- Workspace isolation: each run is bound to a workspace scope via `resolveMasterWorkspaceScope`
  - system mode: normalized to `persona:<masterPersonaId>:<workspaceId>` and rooted at `personas/master/projects/workspaces/<workspace>`
  - legacy mode: remains bound to the requested persona scope `persona:<personaId>:<workspaceId>`
- Side effects: idempotency keys + action ledger (`master_action_ledger`) provide replay-safe execution
- Normal persona paths: the `Master` system persona stays visible in Personas UI but is filtered out of normal chat/swarm persona selection in V1

## Runtime Topology

- Control plane:
  - `MasterOrchestrator` controls lifecycle and approvals
  - persistent approval requests live in `master_approval_requests`
  - operator tool policy lives in `master_tool_policies`
  - user interactions remain responsive during delegation
- Worker plane:
  - delegation dispatcher, inbox, subagent pool, aggregation, recovery
  - durable operator-facing session state lives in `master_subagent_sessions`
  - run ownership and session execution use lease fields (`ownerId`, `leaseExpiresAt`, `heartbeatAt`)
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
    - approval-producing actions return durable request ids
  - `GET/POST /api/master/runs/[id]/delegations`
  - `POST /api/master/runs/[id]/feedback`
    - stores completed-run feedback (`rating`, `policy`, optional `comment`)
- Approvals:
  - `GET /api/master/approvals`
  - `POST /api/master/approvals/[id]/decision`
- Subagents:
  - `GET /api/master/subagents`
  - `GET/PATCH /api/master/subagents/[id]`
- Productivity:
  - `GET/POST/PATCH/DELETE /api/master/notes`
  - `GET/POST/PATCH/DELETE /api/master/reminders`
  - `GET/PATCH/DELETE /api/master/reminders/[id]`
  - `POST /api/master/reminders/[id]/fire`
- Observability:
  - `GET /api/master/metrics`
  - `GET /api/master/events` (SSE invalidation stream: `connected`, `heartbeat`, `updated`; UI keeps a guarded polling fallback)
- Settings:
  - `GET/PUT /api/master/settings`
  - available only while `MASTER_SYSTEM_PERSONA_ENABLED` is enabled
  - authoritatively updates Master model binding, instruction files, autonomy settings, tool allowlist, and operator tool policy

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
  - fixed system-persona operation in system mode
  - legacy persona selection only when `MASTER_SYSTEM_PERSONA_ENABLED` is disabled
  - workspace scope selection
  - contract creation (`Create Master Run`)
  - run start and export controls
  - approval queue with durable decisions (`approve_once`, `approve_always`, `deny`)
  - subagent session visibility for delegated work
  - reminder/automation panel
  - live metrics plus SSE status with polling fallback
  - `Settings` tab for Master persona configuration and tool policy in system mode only

## Verification Snapshot

Validated in this implementation:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test -- tests/unit/master tests/integration/master`
- `npm test` (full suite)
