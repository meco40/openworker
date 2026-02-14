# Mem0 Persona Long-Term Learning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate Mem0 as an optional, production-safe long-term persona memory backend while preserving existing API behavior and SQLite fallback.

**Architecture:** Keep SQLite as local source-of-truth for CRUD/UI and feedback loops. Add an optional Mem0 REST adapter used by `MemoryService` for Mem0-first recall and sync on writes. Any Mem0 failure must degrade gracefully to current local behavior.

**Tech Stack:** TypeScript, Next.js API routes, Vitest, Node `fetch`/AbortController, existing memory service + SQLite repository.

---

## Production-Ready Rules

1. **Fail-open behavior:** Mem0 failures must never break chat/memory API calls. Local SQLite flow continues.
2. **Scope isolation:** Every Mem0 request must include both `user_id` and persona binding (`agent_id`) to prevent cross-user or cross-persona leakage.
3. **Deterministic fallback:** If Mem0 search fails or returns empty, run existing local embedding recall path unchanged.
4. **Bounded latency:** Mem0 requests run with strict timeout; no unbounded wait in request path.
5. **No secret leakage:** API key only via env, never logged; logs contain only safe operational metadata.
6. **Compatibility:** Existing `/api/memory` contracts and `MessageService` behavior remain backward-compatible.
7. **Feedback loop preserved:** Existing negative/positive feedback learning remains active even with Mem0 enabled.
8. **Operational clarity:** Document env toggles and rollout/rollback path.

## Plan Self-Review (Risks + Mitigations)

- **Risk:** Mem0 response schema may vary across versions.
  **Mitigation:** Defensive parser accepting multiple common field layouts, test-covered.
- **Risk:** Recall IDs from Mem0 may not map to local nodes.
  **Mitigation:** Create/update local mirror nodes with `mem0Id` metadata during Mem0 recall.
- **Risk:** Synchronous API methods (`delete`, `bulkDelete`) cannot await Mem0 I/O.
  **Mitigation:** fire-and-forget sync with explicit `.catch` to avoid unhandled rejections.
- **Risk:** Existing health checks assume SQLite only.
  **Mitigation:** Keep SQLite check valid and add provider metadata in service runtime.

### Task 1: Mem0 REST Client (TDD)

**Files:**
- Create: `src/server/memory/mem0Client.ts`
- Create: `tests/unit/memory/mem0-client.test.ts`

**Step 1: Write failing tests**
- Add tests for:
  - building Mem0 client from env only when enabled,
  - add/search request payload with `user_id` and `agent_id`,
  - timeout behavior (AbortController),
  - tolerant parsing of response variants.

**Step 2: Run tests to verify RED**
- Run: `npm test -- tests/unit/memory/mem0-client.test.ts`
- Expected: FAIL (module/functions missing).

**Step 3: Minimal implementation**
- Implement configurable Mem0 client:
  - envs: `MEMORY_PROVIDER`, `MEM0_BASE_URL`, `MEM0_API_KEY`, `MEM0_TIMEOUT_MS`, `MEM0_API_PATH`
  - methods: `addMemory`, `searchMemories`, `updateMemory`, `deleteMemory`
  - helpers: request timeout + defensive JSON parsing.

**Step 4: Run tests to verify GREEN**
- Run: `npm test -- tests/unit/memory/mem0-client.test.ts`
- Expected: PASS.

### Task 2: MemoryService Mem0 Integration (TDD)

**Files:**
- Modify: `src/server/memory/service.ts`
- Modify: `core/memory/types.ts`
- Modify: `tests/unit/memory/memory-service.test.ts`

**Step 1: Write failing tests**
- Add tests proving:
  - store writes local node and attaches Mem0 external id metadata when Mem0 succeeds,
  - recall uses Mem0 result first and returns Mem0-derived context,
  - recall falls back to local similarity path on Mem0 failure,
  - Mem0 recall entries are mirrored to local nodes for feedback compatibility.

**Step 2: Run tests to verify RED**
- Run: `npm test -- tests/unit/memory/memory-service.test.ts`
- Expected: FAIL for new Mem0 behavior assertions.

**Step 3: Minimal implementation**
- Extend `MemoryService` constructor with optional Mem0 client dependency.
- Implement Mem0-first recall path with local fallback.
- On store/update/delete, sync Mem0 best-effort and preserve local path.
- Add metadata fields (`mem0Id`, provider marker) for mirror mapping.

**Step 4: Run tests to verify GREEN**
- Run: `npm test -- tests/unit/memory/memory-service.test.ts`
- Expected: PASS.

### Task 3: Runtime Wiring + Operational Docs (TDD where applicable)

**Files:**
- Modify: `src/server/memory/runtime.ts`
- Modify: `docs/MEMORY_SYSTEM.md`
- Modify: `docs/DEPLOYMENT_OPERATIONS.md`

**Step 1: Add failing/guard tests (if needed) or verify existing behavior constraints**
- Ensure runtime still constructs working memory service in default mode.

**Step 2: Implement wiring**
- Runtime creates Mem0 client from env and injects into `MemoryService`.
- Default remains SQLite-only if Mem0 not configured.

**Step 3: Update docs with rollout rules**
- Add env table and rollout strategy:
  - `MEMORY_PROVIDER=sqlite|mem0`
  - Mem0 URL/key/timeout/path
  - rollback by setting `MEMORY_PROVIDER=sqlite`

**Step 4: Verify docs and runtime compile**
- Run: `npm run typecheck`
- Expected: PASS.

### Task 4: End-to-End Verification

**Files:**
- Verify only (no mandatory file changes)

**Step 1: Run focused memory test suite**
- Run: `npm test -- tests/unit/memory/memory-service.test.ts tests/unit/memory/sqlite-memory-repository.test.ts tests/unit/memory/mem0-client.test.ts tests/integration/memory/memory-route.test.ts`

**Step 2: Run related channel memory behavior tests**
- Run: `npm test -- tests/unit/channels/message-service-memory-recall.test.ts tests/unit/channels/message-service-memory-trigger.test.ts tests/unit/channels/message-service-auto-session-memory.test.ts tests/unit/channels/auto-memory.test.ts`

**Step 3: Run type safety gate**
- Run: `npm run typecheck`

**Step 4: Final status check**
- Run: `git status --short`
- Confirm only intended files changed.
