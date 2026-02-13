# Rooms Critical+High Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stabilize all `critical` + `high` findings in Rooms (reentrancy, stop-race, lease-expiry during long calls, seq-race) without functional regressions.

**Architecture:** Keep existing room domain and APIs, add safety controls at orchestration boundaries and message persistence. Prefer backward-compatible defaults, explicit runtime-role config, and TDD-first for each behavior change.

**Tech Stack:** TypeScript, Node.js, Next.js custom server, better-sqlite3, Vitest.

---

## Scope Mapping (must be fully covered)

1. Reentrancy risk in room cycles.
2. Stop-race causing wrong `degraded` state after user stop.
3. Lease expiry during long `dispatchWithFallback`.
4. `MAX(seq)+1` race for `room_messages.seq`.

## Task 1: Baseline Safety Tests (freeze current behavior and bug repros)

**Files:**
- Create: `tests/integration/rooms/rooms-hardening-baseline.test.ts`
- Modify: `tests/integration/rooms/rooms-runtime.test.ts` (optional shared mocks)
- Test: `tests/integration/rooms/rooms-hardening-baseline.test.ts`

**Step 1: Write failing tests first (@superpowers:test-driven-development)**

```ts
it('repro: beforeSeq NaN currently produces empty page');
it('repro: stopped room can end as degraded after heartbeat failure path');
```

**Step 2: Run tests to verify red**

Run: `npx vitest run tests/integration/rooms/rooms-hardening-baseline.test.ts`  
Expected: FAIL on intended repro assertions.

**Step 3: Keep tests as regression anchors (no production code changes yet)**

```ts
// Mark as known-bug expectations or TODO assertions for next tasks
```

**Step 4: Re-run to ensure deterministic failures**

Run: `npx vitest run tests/integration/rooms/rooms-hardening-baseline.test.ts --reporter=verbose`  
Expected: same failures, reproducible.

**Step 5: Commit**

```bash
git add tests/integration/rooms/rooms-hardening-baseline.test.ts
git commit -m "test(rooms): add baseline repros for critical/high stability issues"
```

### Task 2: Prevent Reentrant `runOnce()` in one process

**Files:**
- Modify: `src/server/rooms/orchestrator.ts`
- Create: `tests/unit/rooms/orchestrator-reentrancy.test.ts`
- Test: `tests/unit/rooms/orchestrator-reentrancy.test.ts`

**Step 1: Write failing test**

```ts
it('skips overlapping runOnce calls on same orchestrator instance', async () => {
  const [a, b] = await Promise.all([orchestrator.runOnce(), orchestrator.runOnce()]);
  expect(a.processedRooms + b.processedRooms).toBe(1);
});
```

**Step 2: Run failing test**

Run: `npx vitest run tests/unit/rooms/orchestrator-reentrancy.test.ts`  
Expected: FAIL (both runs process work).

**Step 3: Implement minimal guard**

```ts
private runInProgress = false;

async runOnce() {
  if (this.runInProgress) return { processedRooms: 0, createdMessages: 0 };
  this.runInProgress = true;
  try { /* existing logic */ }
  finally { this.runInProgress = false; }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/unit/rooms/orchestrator-reentrancy.test.ts tests/integration/rooms/rooms-runtime.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/rooms/orchestrator.ts tests/unit/rooms/orchestrator-reentrancy.test.ts
git commit -m "fix(rooms): prevent overlapping orchestrator cycles in one process"
```

### Task 3: Explicit Runtime Role Selection (web vs scheduler)

**Files:**
- Create: `src/server/rooms/runtimeRole.ts`
- Modify: `server.ts`
- Modify: `scheduler.ts`
- Modify: `docker-compose.yml`
- Create: `tests/unit/rooms/runtime-role.test.ts`

**Step 1: Write failing tests for role resolver**

```ts
expect(resolveRoomRuntimeRole('web', { ROOMS_RUNNER: 'scheduler' })).toBe(false);
expect(resolveRoomRuntimeRole('scheduler', { ROOMS_RUNNER: 'scheduler' })).toBe(true);
```

**Step 2: Run test**

Run: `npx vitest run tests/unit/rooms/runtime-role.test.ts`  
Expected: FAIL (resolver missing).

**Step 3: Implement resolver + wire startup**

```ts
// runtimeRole.ts
export type RoomRunnerMode = 'web' | 'scheduler' | 'both';
export function shouldRunRooms(processRole: 'web' | 'scheduler', env = process.env): boolean { ... }

// server.ts / scheduler.ts
if (shouldRunRooms('web')) startRoomScheduler();
```

Set compose to avoid dual ownership by default:

```yml
web:
  environment:
    ROOMS_RUNNER: scheduler
scheduler:
  environment:
    ROOMS_RUNNER: scheduler
```

**Step 4: Run tests**

Run: `npx vitest run tests/unit/rooms/runtime-role.test.ts tests/integration/rooms/rooms-runtime.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/rooms/runtimeRole.ts server.ts scheduler.ts docker-compose.yml tests/unit/rooms/runtime-role.test.ts
git commit -m "fix(rooms): add explicit runtime role gating for room scheduler"
```

### Task 4: Stop-Race Hardening (`stopped` must win)

**Files:**
- Modify: `src/server/rooms/orchestrator.ts`
- Create: `tests/unit/rooms/orchestrator-stop-race.test.ts`
- Test: `tests/unit/rooms/orchestrator-stop-race.test.ts`

**Step 1: Write failing test**

```ts
it('does not overwrite stopped room to degraded when heartbeat fails after stop');
```

**Step 2: Run failing test**

Run: `npx vitest run tests/unit/rooms/orchestrator-stop-race.test.ts`  
Expected: FAIL (room becomes degraded).

**Step 3: Implement safe error classification**

```ts
const latestRoom = this.repository.getRoom(room.id);
if (latestRoom?.runState === 'stopped') continue;

const activeRun = this.repository.getActiveRoomRun(room.id);
if (!activeRun) continue; // ended elsewhere, no degrade writeback

this.repository.closeActiveRoomRun(room.id, 'degraded', reason);
```

Apply this check both:
- around heartbeat failure near end-of-turn
- in outer `catch` before degraded write.

**Step 4: Run tests**

Run: `npx vitest run tests/unit/rooms/orchestrator-stop-race.test.ts tests/integration/rooms/rooms-runtime.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/rooms/orchestrator.ts tests/unit/rooms/orchestrator-stop-race.test.ts
git commit -m "fix(rooms): prevent degraded overwrite after user stop"
```

### Task 5: Lease Keepalive During Long Dispatch + Abort

**Files:**
- Modify: `src/server/rooms/orchestrator.ts`
- Create: `tests/integration/rooms/orchestrator-lease-keepalive.test.ts`
- Test: `tests/integration/rooms/orchestrator-lease-keepalive.test.ts`

**Step 1: Write failing test**

```ts
it('keeps lease alive during long dispatch and aborts safely on lease loss');
```

**Step 2: Run test**

Run: `npx vitest run tests/integration/rooms/orchestrator-lease-keepalive.test.ts`  
Expected: FAIL.

**Step 3: Implement keepalive timer + abort signal**

```ts
const abortController = new AbortController();
const keepaliveMs = Math.max(1000, Math.floor(this.leaseTtlMs / 3));
const keepalive = setInterval(() => { ...heartbeat... }, keepaliveMs);

const aiResponse = await hubService.dispatchWithFallback(..., {
  modelOverride: selected.model,
  signal: abortController.signal,
});

finally { clearInterval(keepalive); }
```

If keepalive detects lease loss:
- abort dispatch
- do not append persona message
- do not degrade if room already stopped or lease transferred.

**Step 4: Run tests**

Run: `npx vitest run tests/integration/rooms/orchestrator-lease-keepalive.test.ts tests/integration/rooms/rooms-runtime.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/rooms/orchestrator.ts tests/integration/rooms/orchestrator-lease-keepalive.test.ts
git commit -m "fix(rooms): keep lease alive during dispatch and abort on lease loss"
```

### Task 6: Replace `MAX(seq)+1` with Atomic Per-Room Sequence

**Files:**
- Modify: `src/server/rooms/sqliteRoomRepository.ts`
- Modify: `src/server/rooms/repository.ts` (only if helper API needed)
- Create: `tests/integration/rooms/room-message-seq-concurrency.test.ts`
- Test: `tests/integration/rooms/room-message-seq-concurrency.test.ts`

**Step 1: Write failing concurrency-oriented test**

```ts
it('maintains unique monotonic seq under multi-repository writes');
```

**Step 2: Run test**

Run: `npx vitest run tests/integration/rooms/room-message-seq-concurrency.test.ts`  
Expected: FAIL or flaky with current `MAX(seq)+1`.

**Step 3: Implement atomic allocator**

Migration:

```sql
CREATE TABLE IF NOT EXISTS room_message_sequences (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL DEFAULT 0
);
```

Backfill:

```sql
INSERT INTO room_message_sequences (room_id, last_seq)
SELECT room_id, COALESCE(MAX(seq), 0) FROM room_messages GROUP BY room_id
ON CONFLICT(room_id) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq);
```

Append path (single transaction):

```sql
INSERT INTO room_message_sequences (room_id, last_seq) VALUES (?, 0)
ON CONFLICT(room_id) DO NOTHING;
UPDATE room_message_sequences SET last_seq = last_seq + 1 WHERE room_id = ?;
SELECT last_seq FROM room_message_sequences WHERE room_id = ?;
```

Then insert `room_messages` with that `seq`.

**Step 4: Run tests**

Run: `npx vitest run tests/integration/rooms/room-message-seq-concurrency.test.ts tests/unit/rooms/room-repository.test.ts`  
Expected: PASS and deterministic ordering.

**Step 5: Commit**

```bash
git add src/server/rooms/sqliteRoomRepository.ts tests/integration/rooms/room-message-seq-concurrency.test.ts tests/unit/rooms/room-repository.test.ts
git commit -m "fix(rooms): use atomic per-room message sequence allocator"
```

### Task 7: Correct Metrics and Input Validation Safety

**Files:**
- Modify: `src/server/rooms/orchestrator.ts`
- Modify: `app/api/rooms/[id]/messages/route.ts`
- Modify: `tests/integration/rooms/rooms-runtime.test.ts`
- Modify: `tests/integration/rooms/rooms-routes.test.ts`

**Step 1: Write failing tests**

```ts
it('reports createdMessages equal to actually appended room messages');
it('rejects invalid beforeSeq with 400');
```

**Step 2: Run tests**

Run: `npx vitest run tests/integration/rooms/rooms-runtime.test.ts tests/integration/rooms/rooms-routes.test.ts`  
Expected: FAIL.

**Step 3: Implement fixes**

```ts
// orchestrator.ts: remove trailing unconditional createdMessages += 1
// messages route: parse beforeSeq with Number.isFinite(...) && > 0 else 400
```

**Step 4: Run tests**

Run: `npx vitest run tests/integration/rooms/rooms-runtime.test.ts tests/integration/rooms/rooms-routes.test.ts`  
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/rooms/orchestrator.ts app/api/rooms/[id]/messages/route.ts tests/integration/rooms/rooms-runtime.test.ts tests/integration/rooms/rooms-routes.test.ts
git commit -m "fix(rooms): correct createdMessages metric and harden beforeSeq validation"
```

### Task 8: Documentation + Rollout + Verification Gate

**Files:**
- Modify: `docs/PERSONA_ROOMS_SYSTEM.md`
- Modify: `docs/2026-02-12-rooms-stability-performance-analysis.md`
- Create: `docs/plans/2026-02-12-rooms-critical-high-hardening-rollout.md`

**Step 1: Add rollout docs**

Include:
- env matrix (`ROOMS_RUNNER`)
- expected process topology
- rollback switch (set `ROOMS_RUNNER=both` + disable keepalive flag if introduced)

**Step 2: Add verification checklist**

```md
- no degraded after manual stop stress test
- no overlapping cycle logs in same process
- no seq collisions under concurrent writes
- long dispatch keeps lease
```

**Step 3: Run full verification**

Run: `npm run lint && npm run test`  
Expected: PASS for changed suites; if global failures are pre-existing, document exact files.

**Step 4: Run targeted production-like smoke**

Run:
`docker compose up -d --build`  
`docker compose logs -f scheduler web`

Expected:
- only configured runner emits room-cycle logs
- no repetitive lease-heartbeat degradation after stop.

**Step 5: Commit**

```bash
git add docs/PERSONA_ROOMS_SYSTEM.md docs/2026-02-12-rooms-stability-performance-analysis.md docs/plans/2026-02-12-rooms-critical-high-hardening-rollout.md
git commit -m "docs(rooms): add hardening rollout and verification guidance"
```

## Critical Plan Review (Best-Case Check)

1. Coverage check: all `critical + high` issues are directly mapped to Tasks 2-6.
2. Regression risk check: each behavior change is test-first and isolated; no API contract changes required.
3. Operational safety check: runtime-role gating prevents unintended dual schedulers in compose deployments.
4. Data safety check: sequence migration is additive (`room_message_sequences`), no destructive rewrite of existing `room_messages`.
5. Failure-mode check: stop-race and lease-loss paths explicitly avoid writing false `degraded` state.
6. Performance check: reentrancy guard + keepalive reduce duplicate work and stale lease churn without changing core dialog logic.
7. Rollback check: runtime behavior can be reverted by env config; schema addition is backward-compatible.

## Open Decisions (resolve before implementation)

1. Default for `ROOMS_RUNNER` in production:
   - Recommended: `scheduler` in compose.
2. Whether to expose keepalive interval as env:
   - Recommended: derive from `leaseTtlMs / 3` first, add env only if needed.

## Execution Order

Implement strictly in this order: Task 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8.
Do not reorder Task 4/5/6 before Task 1-3, because they depend on stable orchestration control.

Plan complete and saved to `docs/plans/2026-02-12-rooms-critical-high-hardening-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
