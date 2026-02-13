# Rooms Implementation Notes

Date: 2026-02-12

## Implemented

- Added Rooms domain backend under `src/server/rooms`:
  - Types, repository contract, SQLite repository, service, runtime singleton, orchestrator, tool executor.
  - SQLite tables: `rooms`, `room_members`, `room_runs`, `room_member_runtime`, `room_persona_sessions`, `room_persona_context`, `room_messages`, `room_interventions`, `persona_permissions`.
  - Repository supports room CRUD basics, member management, run-state transitions (`running`/`stopped`/`degraded`), message pagination by `beforeSeq`, interventions, persona permission storage, lease heartbeat, runtime state, session/context persistence, and active room counts per persona.
- Added Room APIs:
  - `GET/POST /api/rooms`
  - `GET/DELETE /api/rooms/[id]`
  - `POST /api/rooms/[id]/members`
  - `DELETE /api/rooms/[id]/members/[personaId]`
  - `POST /api/rooms/[id]/start`
  - `POST /api/rooms/[id]/stop`
  - `GET /api/rooms/[id]/state`
  - `GET /api/rooms/[id]/messages`
  - `GET/POST /api/rooms/[id]/interventions`
  - `GET /api/rooms/membership-counts`
  - `GET/PUT /api/personas/[id]/permissions`
- Added scheduler integration:
  - `scheduler.ts` now runs a room cycle loop via `RoomOrchestrator` with scheduler instance identity.
- Added gateway room event types and emission:
  - `room.message`, `room.member.status`, `room.run.status`, `room.intervention`, `room.metrics` (constants/types).
  - Service/orchestrator emits `room.*` events, including run status and metrics updates.
- Added runtime behavior:
  - Lease acquisition + heartbeat in `RoomOrchestrator`.
  - Degraded lifecycle when routing is impossible.
  - Dynamic routing order (`member override -> room profile -> p1`).
  - Permission-checked room tool execution loop with session/context updates.
- Added UI integration:
  - New room module: `src/modules/rooms/{types,api,useRoomSync}`.
  - New components: `RoomsColumn`, `RoomDetailPanel`.
  - `components/PersonasView.tsx` now includes a Rooms sidebar column and room detail/timeline panel with Busy/Idle status, live run/intervention/metrics updates, and `active in N rooms` indicator.
- Security hardening:
  - Added auth checks (`resolveRequestUserContext`) to privileged routes:
    - `/api/model-hub/gateway`
    - `/api/model-hub/accounts`
    - `/api/model-hub/accounts/[accountId]/test`
    - `/api/model-hub/accounts/test-all`
    - `/api/model-hub/pipeline`
    - `/api/skills`
    - `/api/skills/execute`
    - `/api/skills/[id]`
- DB concurrency baseline:
  - Added `journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON` to `SqliteMessageRepository`.

## Tests Added

- `tests/unit/rooms/room-repository.test.ts`
- `tests/unit/rooms/room-service.test.ts`
- `tests/integration/rooms/rooms-routes.test.ts`
- `tests/integration/rooms/rooms-runtime.test.ts`
- `tests/integration/security/privileged-routes-auth.test.ts`

## Verification Results

- Targeted feature tests pass:
  - `tests/unit/rooms/room-repository.test.ts`
  - `tests/unit/rooms/room-service.test.ts`
  - `tests/integration/rooms/rooms-routes.test.ts`
  - `tests/integration/rooms/rooms-runtime.test.ts`
  - `tests/integration/security/privileged-routes-auth.test.ts`
- `npm run lint` passes.
- Global `npm run typecheck` still fails because of pre-existing missing route imports in telemetry tests:
  - `tests/integration/telemetry/logs-route.test.ts`
  - `tests/integration/telemetry/logs-ingest-route.test.ts`

## Known Gaps / Follow-up

- Orchestrator still uses a minimal synthetic tool cycle (permission-checked `search`) and does not yet run full multi-turn autonomous LLM planning/review loops.
- Busy duration scheduling (explicit ETA windows and calendar-style unavailability) is not yet modeled beyond runtime status fields.
- Global `npm run typecheck` remains blocked by pre-existing telemetry route import issues unrelated to Rooms.
