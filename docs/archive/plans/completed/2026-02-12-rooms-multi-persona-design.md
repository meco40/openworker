# Rooms Multi-Persona Design

## Goal

Build a `Rooms` capability inside Personas where users can group personas, run long-lived multi-persona conversations, and observe proactive behavior in real time (including busy states and reasoning flow), with server-side 24/7 runtime.

## User-Validated Scope

- Room mode is user-selected per room: `planning`, `simulation`, `free`.
- Start/Stop is manual by user.
- Persona count per room is unlimited.
- No automatic stop by runtime/cost in V1 (manual stop only).
- User may intervene during runs.
- Next speaker is selected dynamically by an orchestrator.
- Model routing is hybrid:
  - persona-specific model override when available,
  - fallback to active global profile pipeline.
- Persona session context is isolated per `room + persona`.
- Rooms run server-side headless (continue with no browser open).
- Busy must be visible in UI:
  - room-local busy status,
  - global persona indicator (`active in N rooms`).
- Persona tool permissions are global per persona.
- Same persona can be active in multiple rooms simultaneously.
- Busy may come from role behavior and task/tool execution.
- Busy durations are real-time.
- After busy ends, persona auto-posts a summary.
- If all personas are busy, orchestrator posts status updates.
- User intervention may hard-interrupt busy immediately.

## Best-Case Hardening (Resolves 7 Review Findings)

### 1) Server-side Tool Execution for Rooms

Problem:

- Existing server chat flow primarily consumes `result.text`; room plan requires real tool-backed behavior.

Best-case solution:

- Add `RoomToolExecutor` in server domain, not client.
- Orchestrator handles gateway `functionCalls` in a loop:
  1. model response with function calls,
  2. permission check per persona,
  3. execute allowed tools server-side,
  4. feed tool outputs back to model for final text,
  5. persist each phase as room events/messages.
- Tool execution updates member runtime state (`busy`, `busy_source=tool`, `current_activity`).

### 2) Guaranteed 24h Runtime Wiring

Problem:

- 24h behavior must not depend on web process or open UI.

Best-case solution:

- Run rooms in scheduler process (`scheduler.ts`) using a dedicated `RoomRuntime` beside automation runtime.
- Add env controls:
  - `ROOMS_TICK_INTERVAL_MS`
  - `ROOMS_LEASE_TTL_MS`
  - `ROOMS_MAX_CONCURRENT_ROOMS`
  - `ROOMS_HEARTBEAT_FILE`
- Extend control-plane metrics endpoint with rooms runtime health (`leaseAge`, `runningRooms`, `degradedRooms`).

### 3) Cross-Store Consistency (Personas vs Rooms)

Problem:

- Personas and chat data are split across DB files; room-member references can orphan.

Best-case solution:

- Store room domain tables in `.local/messages.db` with chat-adjacent repositories for strong room/chat consistency within one DB; persona cross-DB integrity remains service-validated.
- Keep personas in `personas.db`, but enforce reference integrity in service layer:
  - verify persona ownership and existence on room member add/start,
  - on persona delete: detach from room members + emit system room event.
- Add periodic reconciliation job in scheduler (lightweight) to mark broken members as `error` with reason.

### 4) Routing Profile Ambiguity (`p1`)

Problem:

- Current pipeline fallback relies on default `p1`; rooms need explicit profile resolution.

Best-case solution:

- Add `routing_profile_id` on `rooms` (default `p1` initially).
- Add optional member override `model_override` (already planned behavior).
- Routing order per turn:
  1. member `model_override` on room profile,
  2. room `routing_profile_id`,
  3. fallback `p1` only if profile missing.
- Persist `routing_resolution` metadata for observability.

### 5) Session Growth Control for 24h Rooms

Problem:

- Long-lived room sessions need compaction/summarization to keep prompts stable.

Best-case solution:

- Add `room_persona_context` table:
  - `summary_text`, `summary_upto_seq`, `updated_at`.
- For each persona session:
  - summarize every N new messages or when token estimate threshold is exceeded,
  - include summary + recent unsummarized turns in next prompt.
- Keep raw full history in `room_messages` for audit/replay.

### 6) WS Contract for Room Live UI

Problem:

- Existing gateway events do not define `room.*` stream contract.

Best-case solution:

- Add event constants and typed payloads:
  - `room.message`
  - `room.member.status`
  - `room.run.status`
  - `room.intervention`
  - `room.metrics`
- Broadcast scoped by user (`broadcastToUser`) and include monotonic `seq`.
- Frontend adds `useRoomSync` hook (parallel to `useConversationSync`).

### 7) Hard-Interrupt Semantics and Cancellation Limits

Problem:

- Immediate interrupt cannot be fully guaranteed for non-cancelable external work.

Best-case solution:

- Define cooperative cancellation contract:
  - `interrupt_requested` flag at room-member runtime level,
  - abort signal propagation for model calls,
  - tool handlers opt into cancel token support where possible.
- State model:
  - `busy -> interrupting -> interrupted -> available`.
- If a tool cannot abort immediately:
  - mark `interrupting`,
  - suppress follow-up autonomous turns from that persona,
  - force priority response once tool returns.
- UI clearly shows `interrupting` vs `interrupted`.

## Additional Critical Preconditions (Deep Review Additions)

### A) Auth Hardening on Adjacent Execution Surfaces

Risk:

- Existing high-impact API surfaces (`model-hub`, `skills/execute`) are currently callable without per-request user context checks.

Requirement:

- Before room rollout, enforce `resolveRequestUserContext()` on all room-adjacent privileged routes:
  - model-hub account management
  - model-hub gateway dispatch
  - skills execution/install endpoints
- If auth is disabled (`REQUIRE_AUTH=false`), behavior remains single-user legacy mode by explicit policy.

### B) ModelHub and Skills Tenant Scope Policy

Risk:

- Current model-hub and skill persistence is global by default; room ownership is user-scoped.

Requirement:

- Choose and codify one policy in code and docs before implementation:
  1. single-tenant deployment only (explicitly enforced), or
  2. add `user_id` scoping to model-hub and skills persistence/query paths.
- Rooms must reject cross-user profile/account/skill references at service layer.

### C) SQLite Concurrency Baseline for `messages.db`

Risk:

- Rooms scheduler + web process will write concurrently into `.local/messages.db`.

Requirement:

- Enable and verify DB pragmas in message repository before room writes:
  - `PRAGMA journal_mode = WAL`
  - `PRAGMA busy_timeout` (non-zero)
  - `PRAGMA foreign_keys = ON`
- Keep write transactions short and idempotent to reduce lock contention.

### D) 24h Data Growth Controls at API Layer

Risk:

- Room timelines can grow unbounded and make UI/state sync unstable.

Requirement:

- `GET /api/rooms/:id/messages` must be cursor-paginated from day one (`limit`, `beforeSeq`).
- Add retention/archival policy hooks (no forced deletion in V1, but endpoints and schema support for archival readiness).

### E) Safe Tool Surface for Autonomous Rooms

Risk:

- Full tool surface (e.g., shell/db/network) can be overpowered for autonomous 24h behavior.

Requirement:

- Add room-safe default allowlist by tool category; persona permissions can only broaden within server policy ceiling.
- Unsafe tools require explicit admin-level activation and auditable flag.

## Architecture Overview

Use a dedicated Room domain with a headless runtime in scheduler process.

Core modules:

- `RoomRepository` (CRUD + persistent state).
- `RoomService` (API-facing ownership and validation logic).
- `RoomRuntime` (tick scheduling, lease, heartbeat).
- `RoomOrchestratorService` (turn selection, routing, busy lifecycle).
- `RoomRoutingResolver` (member override + room profile fallback).
- `RoomPermissionGuard` (global persona tool permissions).
- `RoomToolExecutor` (server-side function call execution loop).
- `RoomEventBus` (gateway event broadcasting).
- `RoomRecoveryService` (stale lease takeover, degraded recovery).

Integration points:

- Reuse model hub dispatch (`dispatchWithFallback`) with room profile resolution.
- Reuse persona instruction files as persona identity input.
- Reuse gateway websocket and broadcast infrastructure for room live updates.

## Data Model

`rooms`

- `id`, `user_id`, `name`, `goal_mode`, `status`, `routing_profile_id`, `created_at`, `updated_at`

`room_members`

- `room_id`, `persona_id`, `role_label`, `sort_order`, `model_override`, `created_at`

`room_persona_sessions`

- `room_id`, `persona_id`, `session_state_json`, `last_provider`, `last_model`, `updated_at`

`room_persona_context`

- `room_id`, `persona_id`, `summary_text`, `summary_upto_seq`, `updated_at`

`room_messages`

- `id`, `room_id`, `seq`, `speaker_type` (`persona|user|system|orchestrator`), `speaker_persona_id`, `content`, `meta_json`, `created_at`

`room_runs`

- `id`, `room_id`, `state` (`starting|running|stopping|stopped|degraded|recovering`), `started_at`, `stopped_at`, `last_turn_at`, `heartbeat_at`, `worker_id`

`room_member_runtime`

- `room_id`, `persona_id`, `status` (`available|busy|interrupting|interrupted|error`), `busy_reason`, `busy_until`, `busy_source` (`role|task|tool`), `current_activity`, `interrupt_requested`, `updated_at`

`room_interventions`

- `id`, `room_id`, `target_persona_id`, `content`, `priority`, `created_by`, `created_at`, `processed_at`

`persona_permissions` (global per persona)

- `persona_id`, `permissions_json`, `updated_at`

## State Machines

Room run:

- `idle -> starting -> running -> stopping -> stopped`
- `running -> degraded` on repeated unrecoverable failures
- `degraded -> recovering -> running` when recovery succeeds

Room member:

- `available -> busy`
- `busy -> interrupting -> interrupted -> available`
- `busy -> available` on normal completion
- `busy/available -> error` on member-level failures

## Orchestrator Flow

Per room tick:

1. Acquire/validate room lease.
2. Verify run is `running` and not stop-requested.
3. Consume interventions (priority first).
4. Load members + runtime states + session/context snapshot.
5. If all members busy, emit orchestrator status message.
6. Select next member dynamically.
7. Resolve routing (member override -> room profile -> fallback).
8. Build prompt (persona instruction + summary + recent turns).
9. Execute model turn with tool loop (`RoomToolExecutor`).
10. Persist messages/events/usage/cost metadata.
11. Update member status and persona session/context.
12. Broadcast `room.*` events.
13. Heartbeat update.

## Busy Lifecycle

Busy sources:

- role behavior (`Busy: am Kochen`, duration),
- tool/task activity (`Busy: Web-Recherche`).

Behavior:

- Visible in room panel and persona global indicators.
- Carries reason/source/expected end time.
- On completion, persona auto-posts summary.
- On user hard-interrupt:
  - set `interrupt_requested=true`,
  - move `busy -> interrupting`,
  - abort model/tool where supported,
  - force priority response by target persona,
  - finalize `interrupted -> available`.

## Routing and Model Availability

Before each turn:

- Validate member `model_override` against room profile active models.
- If unavailable, use room `routing_profile_id`.
- If still unavailable, fallback to `p1` and annotate `fallback_used=true`.
- If no route available, emit system message and mark member `error`.

Persist routing metadata:

- `resolved_profile_id`, `resolved_provider`, `resolved_model`, `override_requested`, `fallback_used`, `dispatch_latency_ms`, token/cost usage.

## Runtime and Deployment Wiring

- Rooms runtime is scheduler-owned, not UI-owned.
- `scheduler.ts` starts:
  - automation runtime,
  - room runtime.
- Docker compose scheduler container is the canonical long-running host for room execution.
- Room heartbeat integrated with current scheduler heartbeat strategy.

## Required Reliability Features (V1)

- Per-room lock lease (double-run prevention).
- Heartbeat + stale-run takeover.
- Safe stop with abort propagation.
- Retry + backoff for transient failures.
- Degraded mode with actionable reason.
- Structured diagnostics and control-plane metrics.

## API Surface (V1)

- `GET /api/rooms`
- `POST /api/rooms`
- `GET /api/rooms/:id`
- `PUT /api/rooms/:id`
- `DELETE /api/rooms/:id`
- `POST /api/rooms/:id/members`
- `DELETE /api/rooms/:id/members/:personaId`
- `POST /api/rooms/:id/start`
- `POST /api/rooms/:id/stop`
- `POST /api/rooms/:id/interventions`
- `GET /api/rooms/:id/messages?limit=<n>&beforeSeq=<seq>`
- `GET /api/rooms/:id/state`
- `GET /api/personas/:id/permissions`
- `PUT /api/personas/:id/permissions`
- `GET /api/control-plane/metrics` (extended: `rooms` block)

## Gateway Event Contract (`room.*`)

- `room.message`
- `room.member.status`
- `room.run.status`
- `room.intervention`
- `room.metrics`

Each payload includes `roomId` and timestamp; member status payload includes `personaId`, `status`, `busyReason`, `busyUntil`, `source`.

## UI/UX Design

Personas view layout:

- Left area split into `Personas` + `Rooms`.

Room detail panel:

- Shared timeline for all participants.
- Member status badges (`available`, `busy`, `interrupting`, `error`).
- Busy reason + remaining time.
- Run controls (`Start`, `Stop`).
- Intervention input (targeted and broadcast).

Global persona indicators:

- `Active in N rooms`.
- Global busy presence plus current room-local reason.

## Error Handling

- Permission denied tool call:
  - block execution,
  - write explicit system event to room timeline.
- Provider/model failure:
  - retry/backoff, then degrade if exhausted.
- Lock conflict:
  - active runner keeps lease; others exit safely.
- Persistence failure:
  - run to `degraded`, emit diagnostics.
- Orphaned persona reference:
  - member to `error` + UI-visible reason.

## Security and Guardrails

- Strict room ownership checks on all room endpoints.
- Persona ownership validation before membership updates.
- Global persona permission guard before tool invocation.
- Auth checks on all privileged room-adjacent routes (`rooms`, `model-hub`, `skills/execute`, `skills/install`) unless explicit single-user legacy mode is active.
- Explicit tenant-scope enforcement for model profiles/accounts/skills used by room routing and tool execution.
- Sanitized tool output in persisted metadata.
- Audit trail for start/stop, interventions, interrupts, route fallbacks.

## Testing Strategy

Unit:

- turn selection policy
- routing resolver (override/profile/fallback)
- busy transitions (`busy`, `interrupting`, `interrupted`)
- permission guard and tool execution gating
- summary compaction triggers

Integration:

- room CRUD + membership ownership
- scheduler-driven room runtime start/stop
- lock lease + heartbeat takeover
- server-side function-call tool loop
- same persona in multiple running rooms

E2E:

- headless continuity after UI disconnect
- busy visibility in UI (global + room-local)
- all-busy status messaging
- hard-interrupt behavior (`busy -> interrupting -> interrupted`)
- recovery after orchestrator crash/restart

## Non-Goals for V1

- Automatic forced stop by budget/runtime threshold.
- Accelerated simulated time.
- Distributed multi-node sharding beyond lease-based single scheduler host.

## Implementation Readiness

This design now includes best-case solutions for all identified structural risks and is ready for detailed implementation planning (TDD-first).
