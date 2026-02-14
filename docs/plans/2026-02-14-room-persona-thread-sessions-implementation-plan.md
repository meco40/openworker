# Persona-Isolated Room Sessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make each room persona run with an isolated internal chat thread while still sharing the same room conversation stream.

**Architecture:** Extend room persona session state with a per-persona sync cursor (`lastSeenRoomSeq`) and persist per-persona thread messages. On each turn, sync unseen room messages into the persona thread, dispatch using only this thread, and append the response back to both thread and room.

**Tech Stack:** TypeScript, Vitest, Better-SQLite3 repository layer, RoomOrchestrator.

---

### Task 1: Add failing orchestrator test for persona-isolated threads

**Files:**

- Modify: `tests/unit/rooms/orchestrator-reentrancy.test.ts`

**Step 1: Write failing test**

- Add a test with two personas and a mocked ModelHub dispatch that records sent messages.
- Assert each persona keeps its own assistant-thread continuity and receives other persona output as user-attributed room input.

**Step 2: Run test to verify it fails**

- Run: `npm test -- tests/unit/rooms/orchestrator-reentrancy.test.ts`
- Expected: fail due to missing persona thread/session sync behavior.

### Task 2: Add repository support for persona thread + cursor

**Files:**

- Modify: `src/server/rooms/types.ts`
- Modify: `src/server/rooms/repository.ts`
- Modify: `src/server/rooms/roomRowMappers.ts`
- Modify: `src/server/rooms/sqliteRoomRepository.ts`
- Modify: `tests/unit/rooms/room-repository.test.ts`

**Step 1: Add failing repository test**

- Add tests for thread message insert/list and session cursor updates.

**Step 2: Implement minimal repository schema + methods**

- Add `last_seen_room_seq` to `room_persona_sessions`.
- Add `room_persona_thread_messages` table.
- Add upsert/list methods.

**Step 3: Run targeted repository tests**

- Run: `npm test -- tests/unit/rooms/room-repository.test.ts`
- Expected: pass.

### Task 3: Use persona thread in orchestrator

**Files:**

- Modify: `src/server/rooms/orchestrator.ts`

**Step 1: Implement sync + dispatch logic**

- Create/load persona session with cursor.
- Sync unseen room messages into persona thread.
- Dispatch using persona thread only.
- Append assistant/tool results to persona thread and update cursor.

**Step 2: Run tests**

- Run: `npm test -- tests/unit/rooms/orchestrator-reentrancy.test.ts tests/unit/rooms/orchestrator-stop-race.test.ts tests/unit/rooms/room-repository.test.ts`
- Expected: pass.
