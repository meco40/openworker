# Master Autonomy Rollout

## Scope

This runbook covers the rollout of the Master autonomy parity surface:

- generic runtime execution
- persistent approval control plane
- durable subagent sessions
- reminder lifecycle projection and callback handling
- operator SSE stream with polling fallback

## Flags

- `MASTER_SYSTEM_PERSONA_ENABLED`
- `MASTER_GENERIC_RUNTIME_ENABLED`
- `MASTER_APPROVAL_CONTROL_PLANE_ENABLED`
- `MASTER_SUBAGENT_SESSIONS_ENABLED`
- `MASTER_OPERATOR_EVENTS_ENABLED`

Recommended production order:

1. Enable `MASTER_SYSTEM_PERSONA_ENABLED`
2. Enable `MASTER_APPROVAL_CONTROL_PLANE_ENABLED`
3. Enable `MASTER_SUBAGENT_SESSIONS_ENABLED`
4. Enable `MASTER_GENERIC_RUNTIME_ENABLED`
5. Enable `MASTER_OPERATOR_EVENTS_ENABLED`

## Preflight

- Run `pnpm run typecheck`
- Run `pnpm run lint`
- Run `pnpm run test`
- Run `pnpm run check`
- Run `pnpm run build`
- Confirm the SQLite schema includes `master_approval_requests`, `master_tool_policies`, and `master_subagent_sessions`
- Confirm the Master UI can load `/api/master/settings`, `/api/master/approvals`, `/api/master/subagents`, `/api/master/reminders`, and `/api/master/events`

## Smoke Checks

- Create a Master run and confirm `run.start` acquires a lease
- Trigger an approval-producing action and confirm a pending approval request is stored
- Apply `approve_once` and verify the run resumes without duplicate side effects
- Delegate work and confirm a subagent session appears with status transitions
- Create and fire a reminder and confirm the reminder is marked `fired`
- Open the Master page and confirm the status indicator flips to `SSE`; disable `MASTER_OPERATOR_EVENTS_ENABLED` and confirm the UI falls back to polling

## Rollback

- Disable `MASTER_OPERATOR_EVENTS_ENABLED` first if the UI stream is unstable
- Disable `MASTER_GENERIC_RUNTIME_ENABLED` if tool-loop execution regresses
- Disable `MASTER_SUBAGENT_SESSIONS_ENABLED` if delegated session state drifts
- Disable `MASTER_APPROVAL_CONTROL_PLANE_ENABLED` only after confirming no pending approvals require operator action
- Disable `MASTER_SYSTEM_PERSONA_ENABLED` last to return to legacy persona-scoped Master mode

## Recovery Notes

- Stuck runs: inspect `ownerId`, `leaseExpiresAt`, and `heartbeatAt` on the affected run
- Stuck subagent sessions: inspect `/api/master/subagents/[id]` and cancel via `PATCH`
- Reminder drift or duplicate callbacks: inspect `master_audit_events` for `category=reminder`
- Approval backlog: inspect `/api/master/approvals` and `approval_wait_time_p95_ms` from `/api/master/metrics`
