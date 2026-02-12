# Rooms Multi-Persona Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Rooms end-to-end: user-owned room management, scheduler-owned headless runtime, dynamic multi-persona turns with busy/intervention states, and Personas UI integration.

**Architecture:** Introduce a dedicated `src/server/rooms` domain with SQLite persistence in `messages.db`, API surfaces under `app/api/rooms`, and a scheduler runtime loop with lease/heartbeat. Integrate room live events through existing gateway broadcast and add UI in `PersonasView` for Rooms + room timeline/state. Harden privileged routes and enforce persona tool permissions in room tool execution.

**Tech Stack:** Next.js App Router API routes, TypeScript, better-sqlite3, existing gateway websocket event bus, Vitest.

---

### Task 1: Backend Contract Tests First

**Files:**
- Create: `tests/unit/rooms/room-repository.test.ts`
- Create: `tests/unit/rooms/room-service.test.ts`
- Create: `tests/integration/rooms/rooms-routes.test.ts`

**Step 1: Write failing tests for repository CRUD and run/member runtime transitions**

**Step 2: Run tests to verify failure**
- Run: `npm test -- tests/unit/rooms/room-repository.test.ts`

**Step 3: Write failing tests for service ownership checks and routing resolution order**

**Step 4: Run tests to verify failure**
- Run: `npm test -- tests/unit/rooms/room-service.test.ts`

**Step 5: Write failing API integration tests**
- Room CRUD, membership, start/stop, interventions, messages pagination, auth checks.

**Step 6: Run tests to verify failure**
- Run: `npm test -- tests/integration/rooms/rooms-routes.test.ts`

### Task 2: Rooms Domain (Repository + Service)

**Files:**
- Create: `src/server/rooms/types.ts`
- Create: `src/server/rooms/repository.ts`
- Create: `src/server/rooms/sqliteRoomRepository.ts`
- Create: `src/server/rooms/service.ts`
- Create: `src/server/rooms/runtime.ts`
- Modify: `src/server/channels/messages/sqliteMessageRepository.ts`

**Step 1: Implement SQLite room tables and repository methods**
- Include `rooms`, `room_members`, `room_runs`, `room_messages`, `room_member_runtime`, `room_interventions`, `room_persona_sessions`, `room_persona_context`, `persona_permissions`.

**Step 2: Add DB pragma baseline for message DB concurrency**
- `journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON`.

**Step 3: Implement service ownership validation and state transitions**

**Step 4: Run unit tests**
- Run: `npm test -- tests/unit/rooms/room-repository.test.ts tests/unit/rooms/room-service.test.ts`

### Task 3: Rooms API

**Files:**
- Create: `app/api/rooms/route.ts`
- Create: `app/api/rooms/[id]/route.ts`
- Create: `app/api/rooms/[id]/members/route.ts`
- Create: `app/api/rooms/[id]/members/[personaId]/route.ts`
- Create: `app/api/rooms/[id]/start/route.ts`
- Create: `app/api/rooms/[id]/stop/route.ts`
- Create: `app/api/rooms/[id]/interventions/route.ts`
- Create: `app/api/rooms/[id]/messages/route.ts`
- Create: `app/api/rooms/[id]/state/route.ts`
- Create: `app/api/personas/[id]/permissions/route.ts`

**Step 1: Implement authenticated route handlers with `resolveRequestUserContext`**

**Step 2: Wire service operations and pagination contract**
- `GET /messages?limit=&beforeSeq=`.

**Step 3: Run API integration tests**
- Run: `npm test -- tests/integration/rooms/rooms-routes.test.ts`

### Task 4: Scheduler Runtime + Orchestrator

**Files:**
- Create: `src/server/rooms/orchestrator.ts`
- Create: `src/server/rooms/toolExecutor.ts`
- Modify: `scheduler.ts`
- Modify: `app/api/control-plane/metrics/route.ts`

**Step 1: Add room runtime loop with lease + heartbeat**

**Step 2: Add start/stop/degraded lifecycle**

**Step 3: Implement minimal dynamic turn selection and routing order**
- Member override model -> room profile -> `p1`.

**Step 4: Implement function-call tool loop with permission checks**

**Step 5: Run runtime-focused tests**
- Add and run: `tests/integration/rooms/rooms-runtime.test.ts`

### Task 5: Gateway `room.*` Events

**Files:**
- Modify: `src/server/gateway/events.ts`
- Create: `src/modules/rooms/useRoomSync.ts`

**Step 1: Add typed event constants and payload shapes**

**Step 2: Emit `room.message`, `room.member.status`, `room.run.status`, `room.intervention`, `room.metrics` from room runtime/service**

**Step 3: Add frontend subscription hook**

### Task 6: Security Hardening for Privileged Adjacent Surfaces

**Files:**
- Modify: `app/api/model-hub/gateway/route.ts`
- Modify: `app/api/model-hub/accounts/route.ts`
- Modify: `app/api/model-hub/accounts/[accountId]/test/route.ts`
- Modify: `app/api/model-hub/accounts/test-all/route.ts`
- Modify: `app/api/model-hub/pipeline/route.ts`
- Modify: `app/api/skills/route.ts`
- Modify: `app/api/skills/execute/route.ts`
- Modify: `app/api/skills/[id]/route.ts`

**Step 1: Add user-context auth checks**

**Step 2: Keep legacy behavior when auth is disabled**

**Step 3: Add tests**
- Create: `tests/integration/security/privileged-routes-auth.test.ts`

### Task 7: Personas UI Rooms Integration

**Files:**
- Modify: `components/PersonasView.tsx`
- Create: `src/modules/rooms/types.ts`
- Create: `src/modules/rooms/api.ts`
- Create: `src/modules/rooms/components/RoomsColumn.tsx`
- Create: `src/modules/rooms/components/RoomDetailPanel.tsx`

**Step 1: Split Personas left panel into Personas + Rooms columns**

**Step 2: Add Room CRUD and membership management UI**

**Step 3: Add room timeline and runtime status UI**

**Step 4: Add busy indicators**
- Room-local busy reason and global `active in N rooms`.

### Task 8: Verification and Finalization

**Files:**
- Modify: `docs/plans/2026-02-12-rooms-multi-persona-design.md` (if implementation deltas required)
- Create: `docs/ROOMS_IMPLEMENTATION_NOTES.md`

**Step 1: Run targeted validation suite**
- `npm test -- tests/unit/rooms/room-repository.test.ts tests/unit/rooms/room-service.test.ts tests/integration/rooms/rooms-routes.test.ts tests/integration/rooms/rooms-runtime.test.ts tests/integration/security/privileged-routes-auth.test.ts`

**Step 2: Run static checks**
- `npm run typecheck`
- `npm run lint`

**Step 3: Document residual gaps if any**
- Clearly list any non-implemented design points and why.
