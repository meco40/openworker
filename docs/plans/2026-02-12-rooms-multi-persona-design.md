# Rooms Multi-Persona Design

## Goal
Build a new `Rooms` capability inside the Personas area where users can group personas, run long-lived multi-persona conversations, and observe proactive behavior in real time (including busy states and reasoning flow), with server-side 24/7 runtime.

## User-Validated Scope
- Room types are user-chosen per room: `planning`, `simulation`, `free`.
- Start/Stop is manual by user.
- Persona count per room is unlimited.
- No automatic cost/runtime limits in V1 (manual stop only).
- User may intervene during runs.
- Next speaker is selected dynamically by a room orchestrator.
- Model routing is hybrid:
  - Use persona-specific model override when configured and available.
  - Fall back to globally active model pipeline when needed.
- Persona session context is isolated per `room + persona`.
- Rooms run server-side headless (continue even when no browser is open).
- Busy must be visible in UI:
  - room-local busy status,
  - global persona indicator (active in N rooms).
- Persona tool permissions are configured globally per persona.
- Same persona may be active in multiple rooms at once.
- Busy can come from both role behavior and real tasks/tools.
- Busy durations are real time (not accelerated simulation).
- After busy ends, persona posts an automatic summary of what happened.
- If all personas are busy, orchestrator posts room status updates.
- User intervention can hard-interrupt busy immediately.

## Architecture Overview
Use a dedicated Room domain with a headless `RoomOrchestratorService` and persistent room state in SQLite.

Core modules:
- `RoomRepository` (CRUD, state, members, messages, sessions, runs, events).
- `RoomOrchestratorService` (tick loop, turn selection, routing, busy lifecycle).
- `RoomRunManager` (start/stop, lock leasing, heartbeat, recovery).
- `RoomRoutingResolver` (persona override vs global active pipeline checks).
- `RoomPermissionGuard` (global persona tool permission enforcement).
- `RoomEventBus` (gateway/websocket broadcasting for live UI).

Integration points:
- Reuse existing model hub dispatch and active pipeline logic.
- Reuse existing persona files/instructions as persona identity input.
- Add room-specific message/session stores rather than overloading normal web chat conversations.

## Data Model
`rooms`
- `id`, `user_id`, `name`, `goal_mode`, `status`, `created_at`, `updated_at`

`room_members`
- `room_id`, `persona_id`, `role_label`, `sort_order`, `created_at`

`room_persona_sessions`
- `room_id`, `persona_id`, `session_state_json`, `last_provider`, `last_model`, `updated_at`

`room_messages`
- `id`, `room_id`, `speaker_type` (`persona|user|system|orchestrator`), `speaker_persona_id`, `content`, `meta_json`, `created_at`

`room_runs`
- `id`, `room_id`, `state` (`starting|running|stopping|stopped|degraded|recovering`), `started_at`, `stopped_at`, `last_turn_at`, `heartbeat_at`, `worker_id`

`room_member_runtime`
- `room_id`, `persona_id`, `status` (`available|busy|interrupted|error`), `busy_reason`, `busy_until`, `busy_source` (`role|task|tool`), `current_activity`, `updated_at`

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
- `busy -> available` when task/time ends
- `busy -> interrupted` on user hard-interrupt
- `interrupted -> available` after interruption handling
- `busy/available -> error` on member-level failures

## Orchestrator Flow
Per room tick:
1. Acquire/validate room lease lock.
2. Verify room run is still `running` and not stop-requested.
3. Consume high-priority interventions first.
4. Load members and runtime states.
5. If all members busy, emit orchestrator status message and wait.
6. Select next speaking persona via dynamic policy.
7. Resolve routing:
   - persona model override if configured and active,
   - fallback to global active pipeline.
8. Build persona-scoped prompt context using `room_persona_sessions`.
9. Execute model turn and optional tool calls (permission-guarded).
10. Persist message + metadata + token/cost data.
11. Update member status (`busy`/`available`) and session state.
12. Emit websocket events for UI.
13. Heartbeat update.

## Busy Lifecycle
Busy can be initiated by:
- role behavior (`Busy: am Kochen`, duration 20 minutes),
- task/tool activity (`Busy: Web-Recherche`).

Behavior:
- Busy state is visible live in room member panel and global persona list.
- Busy carries reason, source, and expected end time.
- On normal completion, persona posts automatic summary message.
- If interrupted by user command, busy is force-ended:
  - running model/tool call gets abort signal when possible,
  - member state switches to `interrupted`,
  - target persona is prioritized for immediate response.

## Routing and Model Availability
Before each turn:
- Validate persona override model availability in active provider/pipeline.
- If unavailable, fallback to global active pipeline.
- If neither is available, emit system message and mark member `error`.

Routing metadata persisted per turn:
- provider, model, fallback_used, dispatch_latency_ms, usage tokens, estimated cost.

## Required Reliability Features (V1)
- Per-room lock lease to prevent double execution.
- Heartbeat and stale-run takeover recovery.
- Safe immediate stop with abort propagation.
- Retry with backoff on transient provider/tool failures.
- Degraded mode instead of crash loops.
- Structured observability and diagnostics endpoints.

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
- `GET /api/rooms/:id/messages`
- `GET /api/rooms/:id/state`
- `GET /api/personas/:id/permissions`
- `PUT /api/personas/:id/permissions`

## UI/UX Design
Personas view layout:
- Left area split into two columns:
  - `Personas`,
  - `Rooms`.

Room detail panel:
- Shared timeline chat for all room participants.
- Member list with status badges (`available`, `busy`, `error`).
- Busy reason and remaining time display.
- Run controls (`Start`, `Stop`).
- Intervention input for user steering.

Global persona indicators:
- `Active in N rooms`.
- Global busy presence plus room-local details.

## Example Behavior
`Home` room:
- Personas: `Vater`, `Mutter`, `Kind (Nadine)`.
- Same room timeline includes all speakers.
- If `Mutter` starts cooking:
  - member status shows `Busy: am Kochen (20m)`,
  - room continues with other personas,
  - when done, mother auto-posts summary message.

`Office` room:
- Personas collaborate on research and planning.
- Research persona enters busy tool activity while searching.
- Reviewer persona validates findings after results are posted.

## Error Handling
- Tool permission denied:
  - block action,
  - post explicit system message in room timeline.
- Provider outage:
  - retry with backoff,
  - fallback routing,
  - degrade room/member state when exhausted.
- Lock conflict:
  - runner exits and logs takeover-safe event.
- Persistence failure:
  - mark run degraded and expose actionable diagnostics.

## Security and Guardrails
- Room/user ownership checks on all APIs.
- Persona permission checks before tool invocation.
- Sanitized tool outputs in room chat metadata.
- Audit trail for interventions, interrupts, and routing fallback decisions.

## Testing Strategy
Unit:
- turn selection policy
- busy state transitions
- hard-interrupt behavior
- routing resolver fallback logic
- permission guard enforcement

Integration:
- room CRUD + membership APIs
- start/stop lifecycle with lock+heartbeat
- message persistence and state hydration
- multi-room same-persona concurrency behavior

End-to-end:
- headless continuity after UI disconnect
- busy visibility in UI
- all-busy status message behavior
- recovery from orchestrator crash

## Non-Goals for V1
- Automatic stopping by runtime/cost thresholds.
- Accelerated time simulation.
- Advanced multi-process distributed scheduler beyond single-node lock leasing.

## Implementation Readiness
This design is ready for implementation planning. The next step is to create a task-by-task implementation plan (TDD-first) and then execute in isolated worktree.
